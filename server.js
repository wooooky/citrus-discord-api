// Citrus Client — bot + API de presenca do dono (tudo num processo so).
// O site usa GET /api/status e mostra foto, nome, status e bio no card owner.
//
// Requisitos no Discord Developer Portal (https://discord.com/developers/applications):
//   1. App > Bot > Reset Token > colar em DISCORD_TOKEN no .env (NUNCA commitar!)
//   2. Bot > Privileged Gateway Intents > ligar PRESENCE INTENT + SERVER MEMBERS INTENT
//   3. OAuth2 > URL Generator > scope "bot" (sem permissao) > abrir o link e
//      colocar o bot NUM SERVIDOR ONDE VOCE ESTA (senao ele nao ve seu status)
//   4. Ative o modo desenvolvedor no Discord > clique na sua foto > Copiar ID
//      de usuario > colar em OWNER_ID no .env
//
// No Render: Start Command `npm start`. O Render define PORT sozinho (ex: 10000).
// Defina DISCORD_TOKEN e OWNER_ID em Environment Variables (nunca no codigo).
require('dotenv').config();
const express = require('express');
const { Client, Events, GatewayIntentBits } = require('discord.js');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const OWNER_ID = (process.env.OWNER_ID || '').trim();
const PORT = Number(process.env.PORT || 3000);
// Bio/descricao NAO existem na API do Discord p/ bots: edite nas env vars.
// Se BIO ficar vazio, o site mostra seu status personalizado ao vivo.
const BIO = process.env.BIO || '';
const DESCRIPTION = process.env.DESCRIPTION || '';
const CACHE_TTL = 10000;

// Estado da conexao com o Discord (exposto em /health para diagnostico).
const discordState = {
  connected: false,
  readyAt: null,
  lastError: null,
  tag: null,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// NUNCA imprimir o valor do token. Mostra so se existe + tamanho p/ diagnostico.
log(`[boot] Node ${process.version} | PORT=${PORT}`);
log(`[boot] ENV: DISCORD_TOKEN=${TOKEN ? `presente (len=${TOKEN.length})` : 'AUSENTE'} | OWNER_ID=${OWNER_ID || 'AUSENTE'}`);

if (!TOKEN || !OWNER_ID) {
  console.error(
    '[discord] Config incompleta: defina DISCORD_TOKEN e OWNER_ID nas variaveis de ambiente. ' +
    '(Local: copie .env.example para .env. Render: Dashboard > Environment.)'
  );
  discordState.lastError = 'missing-env DISCORD_TOKEN ou OWNER_ID';
  // IMPORTANTE: nao dar process.exit aqui — a API precisa continuar no ar
  // para o Render detectar a porta e para /health explicar o problema.
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
});

// ---- Logs de ciclo de vida do Discord (evita "conecta e nao mostra nada") ----
client.once(Events.ClientReady, (c) => {
  discordState.connected = true;
  discordState.readyAt = new Date().toISOString();
  discordState.lastError = null;
  discordState.tag = c.user.tag;
  log(`[discord] Bot logado como ${c.user.tag}`);
});

client.on(Events.Error, (err) => {
  discordState.lastError = `client-error: ${err && err.message}`;
  console.error('[discord] Erro do client:', err && err.message ? err.message : err);
});

client.on(Events.ShardError, (err) => {
  discordState.lastError = `shard-error: ${err && err.message}`;
  console.error('[discord] Shard error:', err && err.message ? err.message : err);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  discordState.connected = false;
  discordState.lastError = `shard-disconnect (shard ${shardId}, codigo ${event && event.code})`;
  console.error(`[discord] Desconectado (shard ${shardId}, codigo ${event && event.code}). Tentando reconectar...`);
});

client.on(Events.ShardReconnecting, (shardId) => {
  log(`[discord] Reconectando shard ${shardId}...`);
});

client.on(Events.ShardResume, (shardId) => {
  discordState.connected = true;
  discordState.lastError = null;
  log(`[discord] Sessao retomada (shard ${shardId}).`);
});

client.on(Events.Warn, (msg) => {
  console.warn('[discord] Warn:', msg);
});

client.on(Events.Invalidated, () => {
  discordState.connected = false;
  discordState.lastError = 'session-invalidated (token resetado ou sessao invalidada)';
  console.error('[discord] Sessao invalidada. Se trocou o token, atualize DISCORD_TOKEN e faca redeploy.');
});

// Erros nao tratados tambem precisam aparecer no log do Render.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err && err.message ? err.message : err);
});

async function connectDiscord() {
  if (!TOKEN || !OWNER_ID) {
    log('[discord] Login pulado: variaveis de ambiente ausentes. API continua no ar; veja /health.');
    return;
  }
  log('[discord] Conectando ao Discord...');
  try {
    await client.login(TOKEN);
    // O evento ClientReady acima confirma o login. Se o token for invalido
    // ou as intents estiverem erradas, cai no catch ou nos handlers de shard.
  } catch (e) {
    discordState.lastError = `login-failed: ${e && e.message}`;
    console.error('[discord] Falha no login:', e && e.message ? e.message : e);
    console.error('[discord] Confira: (1) token valido (Bot > Reset Token), (2) PRESENCE + SERVER MEMBERS intents ligadas, (3) bot no mesmo servidor que voce.');
    // Mantem o processo vivo: a API continua respondendo /health com o erro.
  }
}

let cache = { at: 0, data: null };

async function fetchStatus() {
  if (!discordState.connected) {
    const err = new Error(discordState.lastError || 'discord ainda conectando, tente de novo em instantes');
    err.code = discordState.lastError ? 'DISCORD_NOT_CONNECTED' : 'DISCORD_CONNECTING';
    throw err;
  }
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL) return cache.data;
  const guilds = Array.from(client.guilds.cache.values());
  let member = null;
  for (const guild of guilds) {
    try {
      const found = await guild.members.fetch(OWNER_ID);
      if (found) { member = found; break; }
    } catch (_) { /* tenta o proximo servidor */ }
  }
  if (!member) {
    const err = new Error('owner-not-found (bot e dono no mesmo servidor? intents ligadas?)');
    err.code = 'OWNER_NOT_FOUND';
    throw err;
  }
  const user = member.user;
  const presence = member.presence;
  const status = (presence && presence.status) || 'offline';
  const activities = (presence && presence.activities) || [];
  const game = activities.find((a) => a && a.type === 0);
  const custom = activities.find((a) => a && a.type === 4);
  const customText = custom && custom.state ? String(custom.state) : '';
  const data = {
    username: user.username,
    globalName: user.globalName || user.username,
    avatarUrl: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null,
    status: status,
    activity: game ? game.name : null,
    bio: BIO || customText,
    description: DESCRIPTION,
    updatedAt: new Date().toISOString(),
  };
  cache = { at: now, data };
  return data;
}

const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});
app.get('/health', (req, res) => res.json({
  ok: true,
  owner: OWNER_ID || null,
  discord: discordState,
}));
app.get('/', (req, res) => res.json({ ok: true, service: 'citrus-discord-api', status: '/api/status' }));
app.get('/api/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await fetchStatus());
  } catch (e) {
    res.status(503).json({ error: 'offline', detail: e && e.code ? e.code : 'unknown' });
  }
});

// 1) Sobe o HTTP PRIMEIRO (o Render exige bind na PORT rapido).
// 2) Depois conecta o bot no MESMO processo.
const server = app.listen(PORT, () => {
  log(`[citrus-api] HTTP na porta ${PORT}`);
  connectDiscord();
});

server.on('error', (err) => {
  console.error(`[citrus-api] Falha ao abrir porta ${PORT}:`, err && err.message ? err.message : err);
  process.exit(1);
});

// Encerramento gracioso (Render manda SIGTERM no redeploy).
function shutdown(signal) {
  log(`[citrus-api] Recebido ${signal}, encerrando...`);
  try {
    server.close(() => log('[citrus-api] HTTP encerrado.'));
    if (client) client.destroy();
  } catch (e) {
    console.error('[citrus-api] Erro ao encerrar:', e && e.message ? e.message : e);
  }
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
