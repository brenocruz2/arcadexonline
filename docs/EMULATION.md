# Execução dos jogos — o que existe e o que falta

## Implementado
- Cadastro de jogo com núcleo (`fbneo`), arquivos extras e **upload de ROM** para storage privado do servidor (`ROM_DIR`).
- Sessão real (`game_sessions`/`session_members`): criação ao aceitar desafio, slots P1/P2 atribuídos pelo servidor, espectadores, reconexão (janela configurável), encerramento (saída, desconexão, timeout, admin) e liberação de recursos.
- Entrega autenticada da ROM apenas a participantes de sessão ativa.
- Relé de entradas (bitmask) jogador→sala validado pelo servidor.
- Execução no navegador via **EmulatorJS (núcleo FBNeo)** com os controles do usuário convertidos para `EJS_defaultControls` (`toEmulatorJS`).

## NÃO implementado (honestidade)
**Multiplayer sincronizado.** Hoje cada jogador roda o emulador localmente; **os estados não são sincronizados** e o espectador não recebe vídeo. Também **não testei** a execução do EmulatorJS (requer ROM licenciada e navegador real) nem o formato exato dos nomes de tecla em `EJS_defaultControls` — valide e ajuste `keyName()/padName()` em `public/js/controls.js`.

## Caminho recomendado para multiplayer real
1. **Worker de emulação** (Linux, container por sessão): FBNeo/libretro headless, 60 fps, aceitando entrada de P1/P2.
2. Worker captura vídeo/áudio → **WebRTC** (ex.: GStreamer + mediasoup/LiveKit/Janus). Jogadores e espectadores recebem o stream; entradas voltam pelo Socket.IO (`session:input`, já existente) ou DataChannel.
3. O Node (`lib/realtime.js`) já cria/encerra sessões: no `challenge:respond` chame um orquestrador (Docker/Nomad/K8s) para alocar o worker, grave `game_sessions.worker_id`, e em `endSession` destrua o container.
4. Alternativa sem streaming: **rollback netcode** com núcleo libretro deterministico (EmulatorJS Netplay/GGPO) — exige servidor de sinalização/TURN.
5. Dimensionar: ~1 vCPU por sessão 2P, banda ~3–6 Mbps por espectador/jogador. Testar carga antes de abrir ao público. Verifique as licenças do emulador e das ROMs (somente conteúdo que você tem direito de distribuir).
