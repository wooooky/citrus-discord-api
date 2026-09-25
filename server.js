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
const dns = require('dns');
const net = require('net');
const https = require('https');
const { Client, Events, GatewayIntentBits } = require('discord.js');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const OWNER_ID = (process.env.OWNER_ID || '').trim();
const PORT = Number(process.env.PORT || 3000);
// Bio/descricao NAO existem na API do Discord p/ bots: edite nas env vars.
// Se BIO ficar vazio, o site mostra seu status personalizado ao vivo.
const BIO = process.env.BIO || '';
const DESCRIPTION = process.env.DESCRIPTION || '';
const CACHE_TTL = 10000;
// Timeout explicito: se client.login() nao resolver nem rejeitar aqui,
// o problema e rede/gateway (e nao token). Ajustavel via env, sem mexer no codigo.
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS || 30000);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 15000);
const GATEWAY_HOST = 'gateway.discord.gg';

// Estado da conexao com o Discord (exposto em /health para diagnostico).
const discordState = {
  connected: false,
  readyAt: null,
  lastError: null,
  tag: null,
  loginAttempt: 0,
  loginStartedAt: null,
  loginResolvedAt: null,
  wsStatus: 'idle',
  gateway: null,
  debugCount: 0,
  lastDebugAt: null,
  lastDebug: null,
  preflight: null,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// NUNCA imprimir o valor do token. Sanitiza qualquer string que possa conte-lo.
// O discord.js emite "[discord:debug] Provided token: xxx.yyy.zzz" com prefixo
// visivel — por isso a redacao aqui e agressiva e cobre ate tokens curtos/fake.
function sanitize(msg) {
  try {
    let s = typeof msg === 'string' ? msg : String(msg && msg.stack ? msg.stack : msg);
    if (TOKEN && s.includes(TOKEN)) s = s.split(TOKEN).join('[TOKEN-REDACTED]');
    // discord.js loga "Provided token: <prefixo visivel>" — redacta a linha toda.
    s = s.replace(/Provided token:.*$/gim, 'Provided token: [TOKEN-REDACTED]');
    // Padrao amplo de token (3 partes com ponto): pega token real e fake/curto.
    s = s.replace(/[\w-]{10,}\.[\w-]{5,}\.[\w-]{10,}/g, '[TOKEN-REDACTED]');
    // Padrao classico de bot token (M/N + comprimentos oficiais).
    s = s.replace(/[MN][A-Za-z0-9_-]{23,}\.[\w-]{6}\.[\w-]{27,}/g, '[TOKEN-REDACTED]');
    return s;
  } catch (_) {
    return '[unloggable]';
  }
}

function tokenShape() {
  if (!TOKEN) return 'AUSENTE';
  const parts = TOKEN.split('.');
  return `presente (len=${TOKEN.length}, partes=${parts.length})`;
}

// NUNCA imprimir o valor do token. Mostra so forma p/ diagnostico.
log(`[boot] Node ${process.version} | PORT=${PORT}`);
log(`[boot] ENV: DISCORD_TOKEN=${tokenShape()} | OWNER_ID=${OWNER_ID || 'AUSENTE'}`);
log(`[boot] Timeouts: LOGIN_TIMEOUT_MS=${LOGIN_TIMEOUT_MS} READY_TIMEOUT_MS=${READY_TIMEOUT_MS}`);
if (TOKEN) {
  const parts = TOKEN.split('.');
  if (parts.length !== 3) {
    console.warn('[boot] AVISO: DISCORD_TOKEN nao tem 3 partes separadas por ponto — pode estar truncado/cortado na env do Render.');
  }
  if (/\s/.test(process.env.DISCORD_TOKEN || '')) {
    console.warn('[boot] AVISO: DISCORD_TOKEN com espacos/quebra de linha nas pontas — sera feito trim, mas confira o valor no Render.');
  }
}

// Mapeia close codes do Gateway p/ diagnostico rapido (sem expor token).
function describeCloseCode(code) {
  const map = {
    1000: 'fechamento normal',
    1001: 'endpoint indo embora (going away)',
    1006: 'conexao anormal perdida (falha TCP/TLS/firewall?)',
    4000: 'erro desconhecido no gateway',
    4001: 'opcode desconhecido',
    4002: 'erro de decode',
    4003: 'nao autenticado (IDENTIFY ausente/expirado)',
    4004: 'falha de autenticacao — token invalido/expirado',
    4005: 'ja autenticado',
    4007: 'sequencia invalida (sessao precisa resume/reconnect)',
    4008: 'rate limited (conectando rapido demais)',
    4009: 'sessao expirou (timeout)',
    4010: 'shard invalido',
    4011: 'sharding obrigatorio (bot grande)',
    4012: 'versao da API invalida (atualize discord.js)',
    4013: 'intents invalidas',
    4014: 'intents privilegiadas desativadas no portal (ligue PRESENCE + SERVER MEMBERS)',
  };
  return map[code] || 'codigo nao mapeado — ver https://discord.com/developers/docs/topics/opcodes-and-status-codes';
}

function currentWsStatus() {
  try {
    if (client && client.ws && typeof client.ws.status !== 'undefined') return String(client.ws.status);
    if (client && client.ws && client.ws.gateway) return `gateway=${client.ws.gateway}`;
  } catch (_) { /* ignore */ }
  return discordState.wsStatus;
}

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

// ---- Diagnostico de ciclo de vida do Discord (Gateway/WebSocket) ----
// Estes handlers existem p/ responder "por que client.login() fica preso?".
// NENHUM deles imprime o token (tudo passa por sanitize()).
client.once(Events.ClientReady, (c) => {
  discordState.connected = true;
  discordState.readyAt = new Date().toISOString();
  discordState.lastError = null;
  discordState.tag = c.user.tag;
  discordState.wsStatus = currentWsStatus();
  try { discordState.gateway = (client.ws && client.ws.gateway) || discordState.gateway; } catch (_) { /* ignore */ }
  log(`[discord] ClientReady como ${c.user.tag} | gateway=${discordState.gateway || 'n/a'} | wsStatus=${discordState.wsStatus}`);
});

// Gateway/WebSocket cru: heartbeats, HELLO, IDENTIFY, RESUMED, etc.
// Essencial quando login() trava sem erro — mostra ate onde o WS chegou.
client.on(Events.Debug, (msg) => {
  discordState.debugCount += 1;
  discordState.lastDebugAt = new Date().toISOString();
  const clean = sanitize(msg).slice(0, 500);
  discordState.lastDebug = clean;
  // Loga tudo do WS/Gateway; linhas de heartbeat sao normais apos HELLO.
  log(`[discord:debug] ${clean}`);
});

client.on(Events.Warn, (msg) => {
  console.warn('[discord:warn]', sanitize(msg).slice(0, 500));
});

client.on(Events.Error, (err) => {
  const clean = sanitize(err && err.stack ? err.stack : err).slice(0, 800);
  discordState.lastError = `client-error: ${sanitize(err && err.message ? err.message : err).slice(0, 300)}`;
  discordState.wsStatus = currentWsStatus();
  console.error(`[discord:error] ${clean} | wsStatus=${discordState.wsStatus}`);
});

client.on(Events.ShardError, (err, shardId) => {
  const clean = sanitize(err && err.stack ? err.stack : err).slice(0, 800);
  const code = err && (err.code !== undefined ? err.code : err.status);
  discordState.lastError = `shard-error (shard ${shardId}, code=${code}): ${sanitize(err && err.message ? err.message : err).slice(0, 300)}`;
  console.error(`[discord:shardError] shard=${shardId} code=${code} wsStatus=${currentWsStatus()} :: ${clean}`);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  discordState.connected = false;
  discordState.wsStatus = currentWsStatus();
  const code = event && event.code;
  const reason = event ? sanitize(event.reason || '').slice(0, 300) : '';
  const wasClean = event ? Boolean(event.wasClean) : 'n/a';
  discordState.lastError = `shard-disconnect (shard ${shardId}, codigo ${code}, wasClean=${wasClean}, motivo="${reason || 'vazio'}")`;
  console.error(
    `[discord:shardDisconnect] shard=${shardId} code=${code} (${describeCloseCode(code)}) ` +
    `wasClean=${wasClean} reason="${reason || 'vazio'}" wsStatus=${discordState.wsStatus}. Tentando reconectar...`
  );
});

client.on(Events.ShardReconnecting, (shardId) => {
  discordState.wsStatus = currentWsStatus();
  log(`[discord:shardReconnecting] shard=${shardId} wsStatus=${discordState.wsStatus} — tentando retomar sessao...`);
});

client.on(Events.ShardResume, (resumed, shardId) => {
  discordState.connected = true;
  discordState.lastError = null;
  discordState.wsStatus = currentWsStatus();
  log(`[discord:shardResume] shard=${shardId} replayed=${resumed} wsStatus=${discordState.wsStatus} — sessao retomada.`);
});

if (Events.ShardReady) {
  client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
    discordState.wsStatus = currentWsStatus();
    log(`[discord:shardReady] shard=${shardId} unavailableGuilds=${unavailableGuilds} wsStatus=${discordState.wsStatus}`);
  });
}

client.on(Events.Invalidated, () => {
  discordState.connected = false;
  discordState.lastError = 'session-invalidated (token resetado ou sessao invalidada)';
  console.error('[discord:invalidated] Sessao invalidada. Se trocou o token (Bot > Reset Token), atualize DISCORD_TOKEN e faca redeploy.');
});

// Erros nao tratados tambem precisam aparecer no log do Render (sem vazar token).
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', sanitize(reason && reason.stack ? reason.stack : reason).slice(0, 800));
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', sanitize(err && err.stack ? err.stack : err).slice(0, 800));
});

// Pre-flight de rede (DNS + TCP + HTTPS) p/ separar "rede bloqueada"
// de "token/intents". Usa so modulos nativos, sem dependencia nova.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout apos ${ms}ms`)), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function checkDns(host, ms = 8000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      dns.lookup(host, (err, address) => (err ? reject(err) : resolve(address)));
    }),
    ms,
    `dns(${host})`
  );
}

function checkTcp(host, port = 443, ms = 8000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const start = Date.now();
      const sock = net.connect(port, host, () => {
        const rtt = Date.now() - start;
        sock.destroy();
        resolve(`ok rtt=${rtt}ms`);
      });
      sock.on('error', (e) => { sock.destroy(); reject(e); });
    }),
    ms,
    `tcp(${host}:${port})`
  );
}

function checkHttps(ms = 10000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const req = https.get('https://discord.com/api/v10/gateway', (res) => {
        res.resume();
        resolve(`http=${res.statusCode}`);
      });
      req.on('error', reject);
    }),
    ms,
    'https(discord.com/api/v10/gateway)'
  );
}

async function preflight() {
  const out = { at: new Date().toISOString(), dns: null, tcp: null, https: null };
  try {
    out.dns = `ok (${await checkDns(GATEWAY_HOST)})`;
    log(`[discord:preflight] DNS ${GATEWAY_HOST} -> ${sanitize(out.dns)}`);
  } catch (e) {
    out.dns = `FALHA: ${sanitize(e.message).slice(0, 200)}`;
    console.error(`[discord:preflight] DNS FALHOU p/ ${GATEWAY_HOST}: ${sanitize(e.message).slice(0, 300)} (rede/DNS do Render bloqueado?)`);
  }
  try {
    out.tcp = await checkTcp(GATEWAY_HOST, 443);
    log(`[discord:preflight] TCP ${GATEWAY_HOST}:443 -> ${sanitize(out.tcp)}`);
  } catch (e) {
    out.tcp = `FALHA: ${sanitize(e.message).slice(0, 200)}`;
    console.error(`[discord:preflight] TCP FALHOU p/ ${GATEWAY_HOST}:443: ${sanitize(e.message).slice(0, 300)} (egress WSS bloqueado? firewall?)`);
  }
  try {
    out.https = await checkHttps();
    log(`[discord:preflight] HTTPS discord.com/api/v10/gateway -> ${sanitize(out.https)}`);
  } catch (e) {
    out.https = `FALHA: ${sanitize(e.message).slice(0, 200)}`;
    console.error(`[discord:preflight] HTTPS FALHOU: ${sanitize(e.message).slice(0, 300)}`);
  }
  discordState.preflight = out;
  return out;
}

async function connectDiscord() {
  if (!TOKEN || !OWNER_ID) {
    log('[discord] Login pulado: variaveis de ambiente ausentes. API continua no ar; veja /health.');
    return;
  }
  discordState.loginAttempt += 1;
  discordState.loginStartedAt = new Date().toISOString();
  discordState.loginResolvedAt = null;
  discordState.wsStatus = currentWsStatus();
  const attempt = discordState.loginAttempt;
  log(`[discord] Conectando ao Discord... (tentativa ${attempt}, timeout ${LOGIN_TIMEOUT_MS}ms, gateway ${GATEWAY_HOST})`);

  // 1) Pre-flight: se DNS/TCP falhar aqui, o login() vai travar — e ja sabemos o porquê.
  await preflight();

  // 2) Login com timeout explicito: discord.js nao tem timeout proprio,
  // entao Promise.race evita "para em Conectando..." para sempre.
  log(`[discord] Chamando client.login() (token ${tokenShape()}, intents Guilds+GuildPresences+GuildMembers)...`);
  const loginPromise = client.login(TOKEN);
  // Evita unhandledRejection se o timeout vencer mas o login falhar depois.
  loginPromise.then(
    () => {},
    () => {}
  );
  let loginSettled = false;
  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => {
      if (!loginSettled) {
        reject(new Error(
          `login-timeout: client.login() nao resolveu nem rejeitou em ${LOGIN_TIMEOUT_MS}ms ` +
          `(wsStatus=${currentWsStatus()}, debugCount=${discordState.debugCount}, ` +
          `ultimoDebug="${(discordState.lastDebug || 'nenhum').slice(0, 160)}"). ` +
          `Causas provaveis: (a) egress WSS p/ ${GATEWAY_HOST}:443 bloqueado, ` +
          `(b) handshake TLS/WebSocket travado, (c) evento ClientReady nunca chegou — veja [discord:debug] e [discord:preflight] acima.`
        ));
      }
    }, LOGIN_TIMEOUT_MS);
    if (t.unref) t.unref();
  });

  try {
    await Promise.race([loginPromise.then(() => { loginSettled = true; }), timeoutPromise.then(() => { loginSettled = true; })]);
    // Se chegou aqui sem throw, o race resolveu pelo login (timeout chamaria reject).
    discordState.loginResolvedAt = new Date().toISOString();
    discordState.wsStatus = currentWsStatus();
    try { discordState.gateway = (client.ws && client.ws.gateway) || discordState.gateway; } catch (_) { /* ignore */ }
    log(`[discord] client.login() RESOLVEU (tentativa ${attempt}) wsStatus=${discordState.wsStatus} gateway=${discordState.gateway || 'n/a'}. Aguardando ClientReady em ate ${READY_TIMEOUT_MS}ms...`);
    // 3) Watchdog do ClientReady: login() resolve ANTES do ready. Se ready nao vier,
    // o problema e IDENTIFY/resume (token 4004, intents 4014, etc. — ver shardDisconnect/debug).
    setTimeout(() => {
      if (!discordState.connected) {
        console.error(
          `[discord] TIMEOUT ClientReady: login() resolveu ha ${READY_TIMEOUT_MS}ms mas ClientReady nao chegou. ` +
          `wsStatus=${currentWsStatus()} debugCount=${discordState.debugCount} ` +
          `ultimoDebug="${(discordState.lastDebug || 'nenhum').slice(0, 200)}". ` +
          `Veja [discord:shardDisconnect] (4004=token invalido, 4014=intents privilegiadas OFF) e ative PRESENCE + SERVER MEMBERS no portal.`
        );
        if (!discordState.lastError) discordState.lastError = `ready-timeout após ${READY_TIMEOUT_MS}ms (login resolveu, ready nao chegou)`;
      }
    }, READY_TIMEOUT_MS).unref?.();
    // O evento ClientReady acima confirma o login definitivo.
  } catch (e) {
    loginSettled = true;
    const cleanMsg = sanitize(e && e.message ? e.message : e).slice(0, 500);
    const code = e && (e.code !== undefined ? e.code : e.status);
    discordState.lastError = `login-failed (code=${code}): ${cleanMsg.slice(0, 300)}`;
    console.error(`[discord] Falha no login (tentativa ${attempt}, code=${code}): ${cleanMsg}`);
    if (String(cleanMsg).startsWith('login-timeout:')) {
      console.error('[discord] Diagnostico: promise nem resolveu nem rejeitou. Nao e token rejeitado — e rede/gateway travado. Confira [discord:preflight] (DNS/TCP/HTTPS) e [discord:debug] (chegou HELLO? enviou IDENTIFY?).');
    } else {
      console.error('[discord] Confira: (1) token valido (Bot > Reset Token), (2) PRESENCE + SERVER MEMBERS intents ligadas, (3) bot no mesmo servidor que voce.');
    }
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
