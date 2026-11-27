#!/bin/bash
# Atualiza produção (main, só se testes e build passarem) e teste (último push em PR, mesmo com testes falhando).
# Reconhece o formato de cada release (nativa ou legada, via release-format.sh) durante a transição do ADR-0004.
set -uo pipefail
BASE=/opt/sail
REPO=https://github.com/sailstation/sail-simulator-pro.git
GIT="git --git-dir=$BASE/repo.git"
exec 9>"$BASE/state/deploy.lock"; flock -n 9 || exit 0
export PATH=/opt/node/bin:$PATH

[ -d "$BASE/repo.git" ] || git clone -q --bare "$REPO" "$BASE/repo.git"
$GIT fetch -q --prune origin '+refs/heads/*:refs/heads/*' '+refs/pull/*/head:refs/pull/*/head' || { echo "fetch falhou"; exit 1; }

# Executa código do repositório como usuário sem privilégios, sem rede e sem acesso aos dados.
# O socket do PostgreSQL fica acessível para os testes do backend nativo (banco sail_ci, auth peer).
sandbox() { # dir cmd...
  local dir=$1; shift
  systemd-run --quiet --wait --pipe --collect --uid=sail-build --gid=sail-build \
    -p WorkingDirectory="$dir" -p PrivateNetwork=yes -p ProtectSystem=strict -p ProtectHome=yes \
    -p ReadWritePaths="$dir /run/postgresql" -p PrivateTmp=yes -p NoNewPrivileges=yes -p RuntimeMaxSec=300 \
    -p MemoryMax=2G -E PATH=/opt/node/bin:/usr/bin:/bin "$@"
}

# Dependências da release nativa (npm ci --ignore-scripts) com rede, em etapa separada do sandbox.
npm_ci() { # dir
  systemd-run --quiet --wait --pipe --collect --uid=sail-build --gid=sail-build \
    -p WorkingDirectory="$1" -p ProtectSystem=strict -p ProtectHome=yes \
    -p ReadWritePaths="$1" -p PrivateTmp=yes -p NoNewPrivileges=yes -p RuntimeMaxSec=300 \
    -p MemoryMax=1G -E PATH=/opt/node/bin:/usr/bin:/bin -E HOME=/tmp \
    npm ci --ignore-scripts --no-audit --no-fund
}

release() { # sha -> diretório extraído
  local sha=$1 dir="$BASE/releases/$1"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir.tmp" && $GIT archive "$sha" | tar -x -C "$dir.tmp" && chown -R sail-build:sail-build "$dir.tmp" && mv "$dir.tmp" "$dir"
  fi
  echo "$dir"
}

activate() { # env sha dir tests build source
  local env=$1 sha=$2 dir=$3
  printf '{"env":"%s","sha":"%s","source":"%s","tests":"%s","build":"%s","deployed":"%s"}\n' \
    "$env" "$sha" "$6" "$4" "$5" "$(date -Is)" > "$dir/DEPLOY.json"
  chmod -R a+rX "$dir"
  ln -sfn "$dir" "$BASE/$env/current.new" && mv -T "$BASE/$env/current.new" "$BASE/$env/current"
  echo "$sha" > "$BASE/state/$env.sha"
  systemctl restart "sail@$env"
  echo "$env -> $sha ($6) testes=$4 build=$5"
}

# Testes e build conforme o formato da release (transição do ADR-0004):
# nativo — npm ci, testes de scripts/ e server/ contra o banco sail_ci, build = main.mjs + node_modules/pg;
# legado — testes de scripts/ e empacotamento do Worker (build-site.mjs).
run_checks() { # dir -> define FORMAT, TESTS e BUILD
  FORMAT=$("$(dirname "$0")/release-format.sh" "$1")
  if [ "$FORMAT" = nativo ]; then
    npm_ci "$1" > "$1/npm.log" 2>&1 && DEPS=ok || DEPS=falhou
    sandbox "$1" bash -c 'node --test scripts/*.test.mjs &&
      DATABASE_URL="postgresql://%2Frun%2Fpostgresql/sail_ci" node --test server/*.test.mjs' > "$1/tests.log" 2>&1 && TESTS=ok || TESTS=falhou
    if [ "$DEPS" = ok ] && [ -f "$1/server/main.mjs" ] && [ -d "$1/node_modules/pg" ]; then BUILD=ok; else BUILD=falhou; fi
  else
    sandbox "$1" bash -c 'node --test scripts/*.test.mjs' > "$1/tests.log" 2>&1 && TESTS=ok || TESTS=falhou
    sandbox "$1" node scripts/build-site.mjs > "$1/build.log" 2>&1 && BUILD=ok || BUILD=falhou
  fi
}

app_healthy() { # porta
  for i in $(seq 1 10); do
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$1/" &&
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
        -d '{"code":"AAAA222","token":"x"}' "http://127.0.0.1:$1/api/rooms/sync")" = 404 ] && return 0
    sleep 2
  done
  return 1
}

# Produção: main, somente se testes e build passarem; reverte sozinha se não ficar saudável.
sha=$($GIT rev-parse refs/heads/main)
if [ "$sha" != "$(cat $BASE/state/prod.sha 2>/dev/null)" ] && [ "$sha" != "$(cat $BASE/state/prod.failed 2>/dev/null)" ]; then
  dir=$(release "$sha"); run_checks "$dir"
  if [ "$TESTS" = ok ] && [ "$BUILD" = ok ]; then
    previous=$(readlink -f "$BASE/prod/current" 2>/dev/null || true)
    activate prod "$sha" "$dir" "$TESTS" "$BUILD" main
    if ! app_healthy 9000; then
      echo "prod: $sha não ficou saudável; revertendo para $previous"
      echo "$sha" > "$BASE/state/prod.failed"
      if [ -n "$previous" ]; then
        ln -sfn "$previous" "$BASE/prod/current"; basename "$previous" > "$BASE/state/prod.sha"; systemctl restart sail@prod
      fi
    fi
  else echo "$sha" > "$BASE/state/prod.failed"; echo "prod: $sha rejeitado (testes=$TESTS build=$BUILD); produção mantida"; fi
fi

# Infraestrutura (GitOps): deploy/ da main testada é aplicado sozinho, com validação, backup e rollback.
# Só a main aplica infraestrutura; PRs nunca rodam como root.
if [ "$(cat $BASE/state/prod.sha 2>/dev/null)" = "$sha" ]; then
  tree=$($GIT rev-parse -q --verify "$sha:deploy" 2>/dev/null || true)
  if [ -n "$tree" ] && [ "$tree" != "$(cat $BASE/state/infra.tree 2>/dev/null)" ] && [ "$tree" != "$(cat $BASE/state/infra.failed 2>/dev/null)" ]; then
    stage=$(mktemp -d); $GIT show "$sha:deploy/infra-apply.sh" > "$stage/infra-apply.sh" && chmod 700 "$stage/infra-apply.sh"
    "$stage/infra-apply.sh" "$sha" "$tree"; rm -rf "$stage"
  fi
fi

# Teste: último push em PR de branch deste repositório (PRs de forks externos não são executados).
heads=$($GIT for-each-ref --format='%(objectname)' refs/heads/)
current=$($GIT for-each-ref --format='%(refname) %(objectname)' 'refs/pull/*/head' | grep -F -f <(echo "$heads") | sort)
previous=$(cat "$BASE/state/test.refs" 2>/dev/null)
changed=$(comm -13 <(echo "$previous") <(echo "$current") | awk 'NF')
[ -z "$previous" ] && changed=$current
if [ -n "$changed" ] || [ ! -e "$BASE/test/current" ]; then
  pick=$(echo "$changed" | awk 'NF' | while read -r ref s; do echo "$($GIT show -s --format=%ct "$s") $s $ref"; done | sort -n | tail -1)
  if [ -n "$pick" ]; then read -r _ sha ref <<< "$pick"; src="PR #$(echo "$ref" | cut -d/ -f3)"
  else sha=$($GIT rev-parse refs/heads/main); src=main; fi
  if [ "$sha" != "$(cat $BASE/state/test.sha 2>/dev/null)" ]; then
    dir=$(release "$sha"); run_checks "$dir"
    if "$(dirname "$0")/release-format.sh" --pronta "$dir"; then activate test "$sha" "$dir" "$TESTS" "$BUILD" "$src"
    else echo "test: $sha sem build utilizável (formato=$FORMAT build=$BUILD); teste mantido"; fi
  fi
fi
echo "$current" > "$BASE/state/test.refs"

# Mantém as 10 releases mais recentes, preservando as ativas.
keep="$(readlink -f $BASE/prod/current) $(readlink -f $BASE/test/current)"
ls -1dt $BASE/releases/*/ 2>/dev/null | tail -n +11 | while read -r d; do d=${d%/}; [[ " $keep " == *" $d "* ]] || rm -rf "$d"; done
exit 0
