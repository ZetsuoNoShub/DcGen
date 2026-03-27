# Discord Inventory Bot

A Discord bot + web control panel for managing and distributing inventory codes to users by tier.

---

## Features

- **`.gen`** — Users generate a code from the inventory channel based on their tier (Free / Booster / Premium / God)
- **`.link`** — Staff send a browser login link via DM
- **`.tv`** — Staff initiate a TV code activation flow via DM
- **`.send`** — Staff DM a credentials file to a user
- **`.pls`** — Vouch profile card with reaction-based upvote/downvote
- **`.tpls`** — Persistent vouch panel with button interactions
- **`.stock`** — Show current stock levels by tier
- **Web Panel** (`control.html`) — Full inventory management UI (add services, upload/generate codes, view stock, manage inventory)

---

## Stack

- **Bot** — Node.js + [discord.js v14](https://discord.js.org/)
- **Database** — [Supabase](https://supabase.com/) (PostgreSQL)
- **Frontend panel** — Vanilla HTML/CSS/JS (single file, no build step)
- **Hosting** — Any Node.js host (Railway, Pterodactyl, VPS, etc.)

---

## Setup

### 1. Prerequisites

- Node.js 18+
- A Supabase project
- A Discord bot (with Message Content Intent enabled)

### 2. Clone & install

```bash
git clone https://github.com/your-username/cloudiverse.git
cd cloudiverse
npm install
```

### 3. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials. See comments in the file for where to find each value.

### 4. Set up Supabase tables

Run the following SQL in your Supabase SQL editor:

```sql
-- Services table
create table services (
  id bigint generated always as identity primary key,
  name text not null,
  tier text not null default 'free',
  cooldown int not null default 0,
  is_stepped boolean not null default false
);

-- Codes table
create table codes (
  id bigint generated always as identity primary key,
  service_id bigint references services(id),
  code_text text not null,
  is_used boolean not null default false,
  created_at timestamptz default now()
);

-- Pending claims table (for redirect tokens)
create table pending_claims (
  id bigint generated always as identity primary key,
  token text not null unique,
  code_id bigint,
  code_text text,
  service_name text,
  expires_at timestamptz,
  claimed boolean default false
);

-- Vouches table
create table vouches (
  id bigint generated always as identity primary key,
  user_id text not null,
  guild_id text not null,
  username text,
  vouches int default 0,
  vouch_history jsonb default '[]',
  last_vouch_time timestamptz,
  unique(user_id, guild_id)
);
```

### 5. Configure Discord IDs

Fill in your server's role and channel IDs in `.env`. To get IDs, enable Developer Mode in Discord settings then right-click any channel/role.

### 6. Run the bot

```bash
node index.js
```

### 7. Web panel

Open `control.html` directly in your browser (no server needed — it talks to Supabase directly).

Set `ADMIN_PASSWORD` in `.env`, then update the `ADMIN_PASS` constant at the top of `control.html` to match, or wire it to read from a config.

---

## Tier System

| Tier    | Role required     | Notes                        |
|---------|-------------------|------------------------------|
| Free    | Everyone          | Default                      |
| Booster | Booster role      | Server booster perks         |
| Premium | Premium role      | Paid/special members         |
| God     | God role          | Top-tier access              |
| Send    | Staff only        | Direct credential delivery   |
| Hidden  | Staff only        | Backup/mirror tier           |

---

## Vouch System

- `.pls @user` — Shows a profile card; others react with custom emojis to upvote/downvote
- `.tpls @user [hours]` — Creates a persistent button-based panel (default 24h)
- Cooldowns prevent duplicate vouches within 12 hours per pair
- Vouches are tracked per-server and aggregated globally

---

## Security Notes

> ⚠️ **Before publishing:** rotate all secrets. Anyone who has seen the repository history may have your old credentials.

- Rotate your Supabase service role key
- Regenerate your Discord bot token
- Change the admin panel password
- Never commit `.env` — it is already in `.gitignore`
- The web panel uses your Supabase service role key client-side. For production, consider adding Supabase RLS policies or proxying requests through a backend.

---

## Project Structure

```
├── index.js              # Main bot file
├── models/
│   └── vouchModel.js     # Vouch DB helpers
├── control.html          # Web inventory panel
├── standard.gif          # Optional banner GIF for embeds
├── .env.example          # Environment variable template
└── .env                  # Your local config (not committed)
```

---

## License

MIT
