# Bot + API de presença do dono (Citrus Client)

O site lê `GET /api/status` e mostra foto, nome, status (online/ausente/ocupado/offline)
e bio no widget do dono. Sem esse servidor no ar, o widget mostra estado neutro.

## 1. Criar o bot (1 vez)

1. Abra https://discord.com/developers/applications > **New Application**.
2. Aba **Bot** > **Reset Token** > copie (esse é o `DISCORD_TOKEN`).
3. Na mesma aba, em **Privileged Gateway Intents**, ligue:
   - **Presence Intent**
   - **Server Members Intent**
   - Salve (Save Changes).
4. Aba **OAuth2 > URL Generator**: marque o scope **bot** (nenhuma permissão
   precisa), abra o link gerado e coloque o bot **num servidor onde VOCÊ está**.
5. Confirme seu ID numérico em `OWNER_ID` (Ative modo desenvolvedor no Discord
   > clique na sua foto > Copiar ID de usuário).

## 2. Rodar local

```bat
copy .env.example .env
notepad .env
npm install
npm start
```

Teste: http://localhost:3000/api/status (tem que voltar seu JSON).

## 3. Subir pra host (Render/Railway/Fly/etc.)

- **Start command:** `npm start`
- **Variáveis de ambiente:** `DISCORD_TOKEN`, `OWNER_ID`, `BIO`, `DESCRIPTION`
  (`PORT` a host define sozinha).

## 4. Diagnóstico (Render)

- Abra **Logs** e procure por `[boot]`, `[discord]` e `[citrus-api]`.
  - `[discord] Config incompleta` = faltam env vars no Dashboard > Environment.
  - `[discord] Falha no login` = token inválido ou intents desligadas
    (ligue **Presence Intent** + **Server Members Intent**).
  - `[discord] Bot logado como ...` = ok.
- Abra `GET /health`: o campo `discord.lastError` explica o problema sem
  derrubar a API. `GET /api/status` retorna `503` com `detail` enquanto o
  bot não estiver conectado.

## Importante

- **Bio de verdade não existe na API pra bots.** Se `BIO` estiver preenchido,
  usa ele; se estiver **vazio**, o site mostra seu **status personalizado ao vivo**.
- **NUNCA commite o `.env`**. Vazou token? Bot > Reset Token e troque em todo lugar.
- Status só aparece certo se o bot dividir servidor com você.
