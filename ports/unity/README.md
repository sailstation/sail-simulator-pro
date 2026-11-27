# Sail Simulator Pro — projeto Unity e cliente web compatível

## Abrir o projeto

No Unity Hub, importe a pasta que contém `Assets`, `Packages` e `ProjectSettings`. A versão configurada é **6000.0.58f1**. Abra `Assets/Scenes/Regatta.unity` e pressione Play. O componente de inicialização cria o menu, a câmera e a raia. O ZIP contém o código-fonte. O jogo publicado para iPhone segue em https://santos-sail.guilherme279095.chatgpt.site/.

## O que foi portado

O cliente Unity executa em C# o campo de ondas de profundidade finita, amostragem da altura, inclinação e velocidade orbital, rajadas, aceleração baseada na resistência, resposta do leme, objetivos do percurso e controle da regata. Os modelos e as polares saem do cliente web de referência. Os arquivos em `Assets/Resources` já vêm prontos para uso.

O modo solo tem cinco bots. Os três cenários oferecem quatro raias. O menu permite escolher classe, condições manuais ou consultar a previsão. As quatro classes têm geometria separada de casco, vela e tripulação. A pose do proeiro do Star tem variação de popa. A simulação usa metros, segundos e m/s internamente. O norte é +Z em Unity e −Y no protocolo web. `Rooms.cs` e o envio de posição fazem a comunicação com a API compartilhada; o token da sala fica em memória.

## Estado de paridade

| Área | Implementação Unity | Limite desta entrega |
|---|---|---|
| Casco, velas e costa | Malhas convertidas do renderizador original, poses de escora, shaders de cores por vértice e esteira de partículas | Reflexos avançados, deformação contínua do pano, qualidade visual e FPS ainda precisam de comparação em dispositivo. |
| Simulação | Quatro componentes de onda, polares por classe, corrente, rajadas, leme, trim, bombeio e recuperação básica | A dinâmica de adernamento, o pêndulo do Star, o auto trim e os bots ainda diferem da versão web. |
| Regata | 180 s de preparação, 300 s de procedimento, OCS, três voltas, passagem de gate e chegada direcional, penalidades por toque e encontros entre barcos | Arbitragem por contato e zona é parcial. Regras 14–17, exceções de 18.3 e o procedimento visual completo das bandeiras ainda requerem paridade. |
| Serviços | Reutiliza o Worker e a base D1. Suporta criação, entrada, saída, partida e sincronização. O anfitrião define condições ao criar a sala. | Compatibilidade do protocolo testada localmente; corrida entre um player Unity compilado e um iPhone real pendente. |
| Interface | Menu, controles de teclado/toque, rumo, ângulos de vento, DTW e minimapa | Áudio e instrumentos detalhados do cliente web permanecem na referência. |

## Testes e builds

- **Gráficos, partículas e fluidos.** `Assets/Tests/FluidGraphicsTests.cs` cobre a malha, normal da superfície, água plana, emissões, deriva das partículas, polares e valores calculados pelo JS original.
- **Lógica e regras de regata.** `RaceTests.cs` e `PassageTests.cs` cobrem fases do relógio, OCS, cruzamento pelos extremos, três voltas, giros, preferência e espaço na marca.
- **Usabilidade e backend.** `UsabilityBackendTests.cs` cobre a curva de leme e o contrato de entrada e resposta das salas. `Backend/rooms.test.mjs` envia requisições HTTP simuladas para o Worker real com a migração SQL em SQLite em memória. Os casos exercitam lotação, validação, permissões, expiração lógica ao fechar, sincronização e separação entre assets e API.

> `Backend/` é uma cópia legada do backend antigo (Cloudflare Worker + D1), mantida sem evolução só como referência deste porte. O backend real do projeto é o servidor nativo em `server/`, com PostgreSQL (ADR-0004); o contrato HTTP da API de salas é o mesmo.

Execute `node --test Backend/rooms.test.mjs Tools/assets.test.mjs` com Node 24. No Unity Test Runner, escolha EditMode e Run All. Para automação em um ambiente com Editor licenciado, defina `UNITY_EDITOR` como o caminho do executável e rode `Tools/validate.sh`; o resultado NUnit sai em `Results/EditMode.xml`. Execute os testes novamente a cada alteração.

O menu **Sail → Build** tem comandos para Web, Android, iOS, Windows, Linux e macOS. Cada destino exige o módulo correspondente no Unity Hub. Exemplo de linha de comando após selecionar o módulo e o alvo no host:

```sh
"$UNITY_EDITOR" -batchmode -quit -projectPath "$PWD" -buildTarget WebGL -executeMethod Sailing.Editor.BuildSail.Web -logFile -
```

Em iOS, o destino gera um projeto Xcode; compilação final e assinatura requerem a equipe Apple do aplicativo e o ambiente Apple apropriado. Use a conta da organização para os certificados. Nenhuma credencial é fornecida.

## Compatibilidade do site e dos dados

`LegacyWeb/dist` contém a versão web de referência. O código do Worker permanece em `Backend/worker.mjs` e o esquema em `Backend/drizzle`. Não reaplique a migração inicial em uma base já existente.

Depois de gerar `Builds/Web`, `node Tools/stage-web.mjs` organiza a versão clássica em `Builds/Hosted/` e o player Unity em `Builds/Hosted/unity/`. A distribuição Web está configurada sem compressão para simplificar a hospedagem inicial. O servidor deve entregar WebAssembly como `application/wasm`. Para implantação com Workers Static Assets, aponte o binding `ASSETS` para esse diretório e `DB` para a base existente, usando `Backend/gateway.mjs` para atender `/api/rooms/*`. O cliente Unity Web usa essa mesma origem. A publicação requer primeiro homologação dos builds, inclusive regressão no Safari e teste entre os dois clientes.

Para atualizar os modelos e polares no projeto após mudanças no legado, execute `node Tools/import-web.cjs LegacyWeb/dist`. A suíte de assets verifica dimensões, valores finitos e correspondência da malha entre poses. O conteúdo de referência deste pacote corresponde ao commit `e72e6a8` do jogo web.

Documentação da Unity: [Web](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-browsercompatibility.html) · [Build iOS](https://docs.unity3d.com/6000.0/Documentation/Manual/iphone-BuildProcess.html).
