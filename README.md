# Sail Simulator Pro

Simulador de regatas da Sailing Solutions e Sail Station. O jogo publicado está em dist/. O backend multiplayer fica em worker/, com migrações em drizzle/. As versões Unity e Godot ficam em ports/, cada uma com seu próprio README.

## Desenvolvimento web

Use Node.js 22 e Python 3. Na raiz do repositório:

```sh
node --test scripts/*.test.mjs
node scripts/build-site.mjs
python3 -m http.server 8000 --directory dist
```

Abra http://localhost:8000 para jogar localmente. O servidor estático permite testar a interface e a regata solo. As salas multiplayer dependem do backend e do banco. O build empacota os recursos, mas não publica o jogo.

## Publicação

Produção em https://sail-pro.sailstation.com (segue a `main` testada) e teste em https://sail-test.sailstation.com (último push em PR). O servidor usa PostgreSQL e está descrito em [docs/infra/servidor.md](docs/infra/servidor.md).

## Contribuição

Siga [ADR-0001](docs/adr/0001-fluxo.md). Abra uma issue com objetivo e critérios de aceite. Registre a decisão antes de implementar. Trabalhe em uma branch por issue e vincule seu PR usando Closes #N. A próxima feature começa após o encerramento do PR da anterior.
