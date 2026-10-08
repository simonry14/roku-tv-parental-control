# Roku TV Parental Control: developer and power-user guide

Most people only need the one-click installer described in the [README](../README.md). This guide is for running it by hand or from source, for other operating systems, and for anyone working on the code. [CLAUDE.md](../CLAUDE.md) is the design record: architecture, decisions and what is still to be verified on real TVs.

How it works in one paragraph: a Node/TypeScript service on an always-on PC watches what the TV is showing through Roku's **External Control Protocol (ECP)** (plain HTTP on port 8060 of the TV), records screen time per app in SQLite, and enforces app rules, viewing hours and daily limits by pressing Home or Power on the TV's behalf. It has a phone dashboard (Fastify + React), optional push notifications (ntfy), and a small sideloaded TV channel that shows why something happened.

---

## 1. Requirements

- **Windows 10/11** PC on the same network as the TV, never sleeping (see [§6](#6-keeping-the-pc-awake))
- **Node.js 22 or later.** Node 24 LTS is recommended: `winget install OpenJS.NodeJS.LTS`. Node 20 reached end of life in April 2026, and better-sqlite3 v13 requires Node 22+.
- A **Roku TV** (or Roku player) on the same LAN. It must not be on a guest or isolated Wi-Fi network.

## 2. TV settings

On the TV (the Roku remote's ⌂ button → Settings):

| Setting                                                                         | Value                | Why                                                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System → Advanced system settings → Control by mobile apps → Network access** | **Enabled**          | Required. In _Limited_ mode, Roku OS 14.1+ blocks key presses and icons, so enforcement can't work. Roku TV Parental Control detects this and flags it. |
| **System → Power → Fast TV start**                                              | **On** (recommended) | Keeps ECP reachable in standby, so the service can tell "TV off" apart from "TV unplugged", and notices immediately when someone turns the TV on.       |
| Router: **DHCP reservation** for the TV                                         | recommended          | Roku TV Parental Control follows the TV by serial number if its IP changes, but a fixed IP is simpler.                                                  |
| Roku account **PIN** (my.roku.com)                                              | recommended          | Stops channels from being added, and makes it harder to change settings unnoticed.                                                                      |
| **Developer mode** (remote: Home ×3, Up ×2, Right, Left, Right, Left, Right)    | optional             | Needed only for the on-screen messages channel ([§12](#12-tv-messages-the-times-up-channel)).                                                           |

## 3. Install

The easy way on Windows is `Install.cmd` (see [Windows installer and releases](#windows-installer-and-releases)). By hand:

```powershell
git clone https://github.com/simonry14/roku-tv-parental-control.git
cd roku-tv-parental-control
npm install
npm run setup            # the wizard: finds the TV, sets the PIN, writes config.json, installs the TV channel
```

`npm run setup` is optional: you can also copy `config.example.json` to `config.json` and edit it. `npm run phone` prints the dashboard's address and a QR code for a phone.

No C++ compiler or Visual Studio is needed. `better-sqlite3` bundles a prebuilt `win32-x64` binary. The project's `.npmrc` sets `ignore-scripts=true`, because npm otherwise ignores the package's `"gypfile": false` flag when installing from `package-lock.json` and tries to run `node-gyp rebuild`. Keep that file.

## 4. Try it without the TV (mock Roku)

Use two terminals:

```powershell
npm run mock-roku        # mock TV: ECP on :8060, control panel on http://localhost:8061
npm run dev:mock         # the service, pointed at the mock (config.mock.json → data/mock.db)
```

- Open **http://localhost:8061** to play "the kid with the remote": power on/off, launch apps, start the screensaver, and switch _Control by mobile apps_ between Enabled, Limited and Disabled. You can also simulate an unplugged TV.
- Run `npm run status:mock` in a third terminal to see live state and today's screen time.
- `config.mock.json` has demo rules in **enforce** mode: YouTube (`837`) and Hulu (`2285`) are blocked, and YouTube Kids (`44444`) is limited to 2 minutes. Launch them from the panel and watch the service press Home. The panel's command log shows each keypress it receives.
- The dashboard runs too: `npm run set-pin -- 123456 --config config.mock.json`, then open http://localhost:8090.
- The mock has the "Time's up" channel installed, and its panel shows what the channel would display. It also has a developer installer on port 8062 (password `mock`) to try `npm run channel:install -- --config config.mock.json --host 127.0.0.1 --port 8062 --password mock`.

The mock also answers SSDP discovery. On Windows, the built-in _SSDP Discovery_ service may hold UDP port 1900. If so, the mock logs a note and carries on, and `config.mock.json` connects by IP anyway.

## 5. Point it at your TV

```powershell
npm run discover          # lists Rokus via SSDP; add -- --scan to also probe the subnet
```

Put the serial you want into `config.json`. If only one Roku is on the network, you can skip this: the service pins the first TV it finds.

```jsonc
{
  "device": { "serial": "X01900ABCDEF", "host": "" }, // host = optional manual IP (fallback if discovery fails)
  "timezone": "America/New_York",
}
```

Then:

```powershell
npm run dev               # run the service (Ctrl+C to stop)
npm run status            # in another terminal: service health, what's on, today's usage
npm run sessions          # recent sessions (-- -n 50 for more; -- --json for machine output)
```

Production build: `npm run build` then `npm start`. To run it in the background permanently, install it as a Windows service ([§13](#13-run-it-as-a-windows-service)).

## 6. Keeping the PC awake

If this is a laptop, prevent it from sleeping while it's plugged in:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# keep running with the lid closed while plugged in:
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

Time while the PC is asleep is **not** counted. The service can't see the TV then, so sessions close at the last confirmed poll.

## 7. Windows Firewall

Discovery needs inbound UDP replies to Node. The first time you run it, Windows asks whether to allow `node.exe`: tick **Private networks**. Make sure your home network is set to **Private** (Settings → Network & Internet → your network → Network profile type). To add the rule yourself, run this in an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Roku TV Parental Control - Node (LAN)" -Direction Inbound `
  -Program (Get-Command node).Source -Protocol UDP -Profile Private -RemoteAddress LocalSubnet -Action Allow
```

The dashboard also needs a TCP rule for its port; see [§10](#10-phone-dashboard).

## 8. How it works

- Every **5 s**, the service polls `GET /query/device-info` (for power-mode). When the screen is on, it also polls `GET /query/active-app`.
- **Screen time** counts only when power-mode is `PowerOn` and a real channel or TV input is on screen. Home screen and screensaver time are tracked separately and never count toward budgets. The "Time's up" dev channel (`dev`) is excluded.
- **Sessions:** a session starts at the first poll that sees an app, and is extended by each later poll that sees the same app. It always ends at its **last confirmed poll**, whether the cause is an app switch, power-off, the TV becoming unreachable, a gap or a restart. Unobserved time is never counted, and the database allows only one open session, so nothing is ever double-counted. The price is under-counting by at most one poll interval per switch.
- **Days** reset at local midnight in the configured time zone, independent of the PC's time zone. DST days (23 h and 25 h) are handled correctly.
- **TV inputs** (HDMI, antenna) appear as apps (`tvinput.hdmi1`, `tvinput.dtv`), so a game console can have rules too.

### Connection health

| Health                    | Meaning                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online` / `tv_off`       | Reachable; screen on / standby                                                                                                                                                           |
| `offline`                 | No answer (fully off, unplugged, Wi-Fi down). Polling backs off to at most every 30 s.                                                                                                   |
| `restricted` · _limited_  | Queries work, but key presses and icons get HTTP 403. Set Control by mobile apps to **Enabled**. A harmless `/query/icon` check every 60 s catches this before enforcement is needed.    |
| `restricted` · _blocked_  | Queries get HTTP 401/403. This is what a Roku TV does when Control by mobile apps is **Disabled**; discovery still finds it.                                                             |
| `restricted` · _disabled_ | Port 8060 refuses connections. A refusal proves a device is at that address, and its ARP MAC confirms it's the TV. The service first checks that the TV hasn't simply moved to a new IP. |
| `searching`               | No TV located yet                                                                                                                                                                        |

## 9. Rules and enforcement

Rules live in the `rules` block of `config.json`. The service reloads them within a second when you save the file, with no restart. If the file is invalid, it keeps the previous rules and logs the error.

```jsonc
"rules": {
  "appPolicy":    { "mode": "blocklist", "apps": ["837"] },          // or "allowlist": only these apps
  "appBudgets":   { "44444": 60 },                                   // minutes per day, by app id
  "globalBudget": { "weekday": 120, "weekend": 180 },                // or 120, or null (unlimited)
  "viewingWindows": {                                                // TV only allowed inside these
    "weekdays": ["15:30-19:30"],
    "weekends": ["08:00-20:00"]
  },
  "quietHours":   ["20:30-07:00"],                                   // TV is turned off if switched on
  "exemptApps":   ["dev"]                                            // never blocked or budgeted
},
"enforcement": { "mode": "dry-run" }                                 // "off" | "dry-run" | "enforce"
```

- **App ids:** run `npm run apps` to see every channel and input on your TV with its id and current rule. TV inputs (`tvinput.hdmi1`, `tvinput.dtv`) are apps too, so a game console can be blocked or limited.
- **Days:** use `mon`…`sun`, `weekdays`, `weekends` or `daily`. A specific day overrides a group, which overrides `daily`. A day set to `[]` means no TV that day. A day you don't list has no window restriction. A window that runs past midnight (e.g. `"fri": ["18:00-01:00"]`) belongs to the day it starts.
- **Quiet hours** can be limited to the nights they start on: `{ "window": "22:00-08:00", "days": ["weekends"] }`.
- **What happens, in priority order:**
  1. Pause (parent watching) → nothing is enforced
  2. Lock → PowerOff
  3. Quiet hours → PowerOff
  4. Outside the viewing window → PowerOff
  5. Blocked app → Home
  6. App limit reached → Home
  7. Daily limit reached → Home

  The Home screen and screensaver are never blocked. Only schedules and locks turn the TV off. With the Roku TV Parental Control channel installed, each action is explained on the TV first, and power-offs come after a short countdown ([§12](#12-tv-messages-the-times-up-channel)).

- **Escalation:** the 3rd app violation within 5 minutes sends PowerOff instead of Home. Configure it with `enforcement.escalation` (`repeats`, `windowMin`).
- **Cooldowns:** at most one Home per 10 s and one PowerOff per 15 s (`cooldownSec`, `powerOffCooldownSec`), so the TV is never spammed.
- **Budgets** count screen time since local midnight. Home screen, screensaver and exempt apps don't count. Bonus minutes are added to the daily limit and every app limit.

### Going live

1. Start in **dry-run** (the default; the dashboard calls it _Practice_). Use the TV normally, then check `npm run events -- --type enforcement`. Lines like `Practice mode: would send Home — YouTube is blocked` (or `would show "YouTube isn't allowed" on the TV`, with the channel installed) show what it would have done.
2. When it looks right, set `"enforcement": { "mode": "enforce" }` and save. The change takes effect within a second.

### Parent controls from the PC

| Command                                | Effect                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run pause -- 60`                  | "Parent is watching": no enforcement for 60 min (omit the number to pause until you resume)     |
| `npm run resume`                       | End a pause or lock                                                                             |
| `npm run lock`                         | Turn the TV off now and keep it off until `npm run unlock` (`-- 30` for 30 min)                 |
| `npm run bonus -- 30`                  | +30 min today. `-- -30` takes it back.                                                          |
| `npm run status`                       | Adds the current rules, what they'd do right now, time left today, and the next schedule change |
| `npm run apps`                         | Every channel/input with its id, rule and today's time                                          |
| `npm run events`                       | Event log: enforcement actions, health changes, overrides (`-- --type enforcement`)             |
| `npm run message -- "Dinner's ready!"` | Show a message on the TV ([§12](#12-tv-messages-the-times-up-channel))                          |

These write to the database the service reads every poll, so they take effect within about 5 s. `lock` sends PowerOff immediately, even in dry-run (the dashboard's Lock shows a 10-second countdown on the TV first, when the channel is installed).

## 10. Phone dashboard

The service serves a dashboard for your phone at **`http://<PC's IP>:8090/`** (`npm run status` prints the exact address). It has four screens:

- **Now:** what's on the TV, time left today, and one-tap Lock, Pause, +15/+30/+60 min, Home and **Message the TV** buttons.
- **Rules:** enforcement mode, daily limits, a 7-day viewing-hours schedule, quiet hours, and per-app block switches and limits with channel icons.
- **History:** a 7-day chart by app and the activity log.
- **Settings:** the TV's address, TV messages, notifications, enforcement tuning and PIN change.

### First-time setup

1. **Set a PIN, on the PC:** `npm run set-pin -- <your PIN>` (4–12 digits, 6+ recommended). For safety, the PIN can't be created from the dashboard, so nobody else on the Wi-Fi can claim it first. Run the command again to change it; this signs every phone out.
2. **Allow the port through Windows Firewall** (elevated PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "Roku TV Parental Control dashboard" -Direction Inbound `
     -Protocol TCP -LocalPort 8090 -Profile Private -RemoteAddress LocalSubnet -Action Allow
   ```

3. On your phone, open the address and enter the PIN. Use **Add to Home Screen** for an app-like icon. A sign-in lasts 30 days (`http.sessionDays`).

### Security model

- **LAN only.** Requests from non-private IP addresses get 403, and the firewall rule is limited to the local subnet. The service listens on all interfaces, so it keeps working when the PC's own DHCP address changes.
- **PIN:** stored as an argon2id hash. Each IP gets 5 login attempts per minute. After 10 wrong PINs in a row, logins lock for 15 minutes, and you get a notification if notifications are set up.
- **Sessions:** a random token in an HttpOnly, SameSite=Strict cookie, with only a hash stored. Changes must be sent as JSON, which blocks cross-site form posts.
- **Plain HTTP on your home network.** Don't forward the port on your router.

### Settings edited in the dashboard

Rules, enforcement, TV messages, notifications, the TV address and the check interval can all be changed in the dashboard. Changes take effect immediately and are saved in the database, where **they override `config.json`**. Each screen shows where its settings come from, and you can switch a section back to `config.json` at any time.

## 11. Notifications (ntfy)

Roku TV Parental Control can push alerts to your phone through [ntfy](https://ntfy.sh), a free app for iPhone and Android:

| Alert                                   | When                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Blocked app opened                      | At most once per app every 10 min                                                                                            |
| Time's up                               | Once per app (or for the daily limit) per day                                                                                |
| TV switched on at night                 | During quiet hours or outside viewing hours; at most every 30 min                                                            |
| **Control blocked: possible tampering** | Someone set _Control by mobile apps_ to Disabled/Limited. Urgent priority, followed by a "restored" message when it's fixed. |
| TV unreachable                          | Only after 30 min offline (configurable), once per outage                                                                    |
| Dashboard locked                        | Repeated wrong PINs                                                                                                          |

Setup: install the ntfy app. In the dashboard, go to **Settings → Notifications** and tap **Make a private topic**. Subscribe to that topic in the app, switch notifications on, save, then tap **Send a test**. Public ntfy.sh topics can be read by anyone who knows the name, so the generated topic is long and random. For a protected topic or your own ntfy server, put the access token in `.env` as `NTFY_TOKEN=…`. Dry-run (practice mode) actions aren't notified unless you turn on _Include practice-mode actions_.

## 12. TV messages (the "Time's up" channel)

On its own, a Roku can only be told to go Home or switch off, which can feel to a child like the TV broke. Roku TV Parental Control comes with a small channel of its own that it opens on the TV to say what's happening:

| When                                       | The TV shows                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A blocked app is opened                    | "YouTube isn't allowed. Pick something else to watch, or ask a parent." (instead of a bare jump to Home)                                                                               |
| An app limit or the daily limit runs out   | "No more YouTube today" / "Screen time's up for today. You can watch again tomorrow from 3:30 PM. To get more time on the TV, read a book, do a chore or practice Python programming." |
| Quiet hours, or outside viewing hours      | "It's quiet time. The TV stays off until tomorrow at 7:00 AM." with a 30-second countdown, then the TV switches off                                                                    |
| A lock from the dashboard, or repeat tries | The reason, with a 10-second countdown, then off                                                                                                                                       |
| An optional warning                        | "5 minutes left" for 8 seconds, then back to the show                                                                                                                                  |
| Your own message                           | Whatever you type in the dashboard (**Now → Message the TV**), or `npm run message -- "Dinner's ready!"` on the PC                                                                     |

Pressing **OK** closes a message and goes to the Home screen. Countdown screens can't be closed, and pressing Home doesn't stop the countdown. If you pause the rules or unlock the TV during a countdown, the countdown stops and the message goes away.

### Install the channel (once)

1. **Turn on developer mode.** With the TV remote, press **Home** three times, **Up** twice, then **Right, Left, Right, Left, Right**. Accept the agreement, choose a password (one the kids won't guess), and let the TV restart.
2. **Put the password in `.env`** in the project folder (create the file if it doesn't exist):

   ```ini
   ROKU_DEV_PASSWORD=the-password-you-chose
   ```

3. **Install:** `npm run channel:install`. The TV opens the channel and shows "Roku TV Parental Control is ready". Press OK to close it.

The service uses the channel from then on. **Settings → TV messages** in the dashboard shows "On the TV". If the channel is ever missing, Roku TV Parental Control falls back to plain Home and PowerOff, so nothing breaks. If the TV loses it (for example, after a factory reset or developer mode being switched off), run `npm run channel:install` again.

- **Change the words.** Every message above can be rewritten in **Settings → TV messages → What the TV says**. Pick a message, edit its headline and text, and watch the preview of the TV screen change as you type. Words in braces are filled in for you: `{app}` (the app's name), `{next}` (when TV time starts again), `{until}` ("until 7:00 AM", or nothing), `{time}`, `{minutes}`, `{limit}` and `{seconds}`. Each message lists the ones it can use, and you can tap one to add it. **Show on the TV** puts your version on the TV with example words (press OK to close it), **Save** makes it the one the TV uses, and **Use the original words** goes back. A line that mentions something unknown, such as `{next}` when no TV time is coming up, is left out. When they've earned more time, give it with **+15 / +30 / +1h** on the Now tab.
- **Settings → TV messages:** switch messages off, change the countdown (0 switches the TV off at once), or turn on the warning before screen time or viewing hours run out (5 or 10 minutes). The warning interrupts the show for a few seconds; the app then reopens, but some apps start from their own home screen rather than where you left off.
- **Dry-run:** nothing appears on the TV, and the log says what would have been shown. Locks and your own messages work in any mode.
- **Without the installer command:** `npm run channel:build` writes `roku-channel/out/roku-guardian-channel.zip`. Open `http://<TV's IP>/` in a browser, sign in as `rokudev` with the developer password, and upload it.
- Developer mode allows one sideloaded channel at a time. It shows on the Home screen as "Roku TV Parental Control", and its screen time is never counted.

## 13. Run it as a Windows service

As a service, Roku TV Parental Control starts with Windows (a minute or two after boot, before anyone signs in) and restarts itself if it crashes or stops.

1. Stop `npm run dev` if it's running (Ctrl+C). Only one copy can control the TV, and a second copy refuses to start.
2. Open Git Bash, PowerShell or Command Prompt **as administrator** (right-click → _Run as administrator_), go to the project folder, and run:

   ```powershell
   npm run service:install
   ```

   This builds the project and installs and starts a service called **Roku TV Parental Control** (`rokutvparentalcontrol.exe` in the Windows Services list).

3. Check it with `npm run service:status`. It reports both the Windows service and whether Roku TV Parental Control inside it is answering, then open the dashboard as usual.

| Command                                                      | Effect                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `npm run service:status`                                     | Running, stopped, or not installed                      |
| `npm run service:stop` / `service:start` / `service:restart` | Needs an administrator terminal                         |
| `npm run service:uninstall`                                  | Removes the service. Your data, logs and settings stay. |

After updating the code, run `npm run build`, then `npm run service:restart`. Rule and settings changes (in `config.json` or the dashboard) need no restart.

The service runs as _Local System_ from the project folder, with the same `config.json`, `.env`, database and log as `npm run dev`. Its console output (warnings only) goes to `logs/service/`; the full log is `logs/roku-guardian.log`. Every start is also noted in `logs/service/launcher.log`, so a start that fails before the app's log opens still leaves a reason. If the app isn't up within 3 minutes, the service starts a fresh copy, and Windows restarts the service if it ever stops on its own.

**NSSM instead.** If you'd rather use [NSSM](https://nssm.cc), skip `service:install` and, in an administrator PowerShell:

```powershell
npm run build
nssm install "Roku TV Parental Control" (Get-Command node).Source "$PWD\dist\src\server.js"
nssm set "Roku TV Parental Control" AppDirectory "$PWD"
nssm set "Roku TV Parental Control" AppEnvironmentExtra ROKU_GUARDIAN_SERVICE=1
nssm set "Roku TV Parental Control" AppStopMethodConsole 15000
nssm start "Roku TV Parental Control"
```

NSSM stops the service with Ctrl+C, which Roku TV Parental Control handles cleanly. Use one or the other, not both.

## 14. Logs and backups

**Logs.** `logs/roku-guardian.log` holds today's log. Each day gets its own file (`roku-guardian.2026-09-30.log`), a day's file is split if it passes 20 MB, and 14 days are kept (`log.keepDays`, `log.maxSizeMb`). The files are JSON lines; `npm run events` is the readable summary.

**Backups.** Every night at 03:30, or as soon as the PC wakes up after that, the service copies the database to `data/backups/roku-guardian-YYYY-MM-DD.db` and keeps the newest 7 (`backup.time`, `backup.keep`, `backup.dir`). The copy is consistent even while the service is writing. `npm run backup` makes one now and lists them; `npm run backup -- --list` only lists.

To restore a backup:

1. Stop the service (`npm run service:stop`) or `npm run dev`.
2. In `data/`, delete `roku-guardian.db-wal` and `roku-guardian.db-shm` if they exist. Replace `roku-guardian.db` with a copy of the backup, renamed to `roku-guardian.db`.
3. Start the service again (`npm run service:start`).

For protection against the PC's disk failing, point `backup.dir` at a synced folder such as OneDrive.

## 15. Configuration

`config.json` is optional. Every field has a default, relative paths resolve against the folder that holds `config.json`, and unknown keys are rejected so typos are caught. Secrets go in `.env` (see `.env.example`).

| Key                                                                | Default                            |                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`                                                         | `America/New_York`                 | IANA zone; budgets reset at local midnight                                                                                                              |
| `device.serial` / `device.host` / `device.port`                    | auto / – / 8060                    | Pin by serial; host is the manual fallback                                                                                                              |
| `monitor.pollIntervalSec`                                          | 5                                  |                                                                                                                                                         |
| `monitor.maxGapSec`                                                | 3 × poll (min 15)                  | Polls further apart than this are not bridged                                                                                                           |
| `monitor.offlineAfterFailures`                                     | 2                                  | Failed polls before health flips (avoids flapping)                                                                                                      |
| `monitor.offlineBackoffMaxSec`                                     | 30                                 | Slowest poll rate while unreachable                                                                                                                     |
| `monitor.restrictionProbeIntervalSec`                              | 60                                 | Limited-mode check; 0 disables it                                                                                                                       |
| `discovery.subnetScan`                                             | true                               | Probe port 8060 on the local /24 when SSDP finds nothing                                                                                                |
| `discovery.interfaces`                                             | all                                | Restrict discovery to these local IPv4 addresses                                                                                                        |
| `usage.excludeAppIds`                                              | `["dev"]`                          | Never counted                                                                                                                                           |
| `database.path`                                                    | `data/roku-guardian.db`            | SQLite in WAL mode                                                                                                                                      |
| `log.level` / `log.file`                                           | `info` / `logs/roku-guardian.log`  | `LOG_LEVEL` in the environment overrides the level                                                                                                      |
| `log.keepDays` / `log.maxSizeMb`                                   | 14 / 20                            | Daily log files kept; size at which a day's file is split                                                                                               |
| `backup.enabled` / `time` / `keep` / `dir`                         | on / `03:30` / 7 / `data/backups`  | Nightly database copy ([§14](#14-logs-and-backups))                                                                                                     |
| `tvMessages.enabled`                                               | true                               | Explain actions on the TV when the channel is installed ([§12](#12-tv-messages-the-times-up-channel))                                                   |
| `tvMessages.countdownSec` / `shortCountdownSec`                    | 30 / 10                            | Countdown before PowerOff (schedules / locks, repeats, quick re-tries); 0 = at once                                                                     |
| `tvMessages.warnBeforeMin` / `warningSec` / `messageSec`           | 0 (off) / 8 / 15                   | Warning before time runs out; how long it and your messages stay up before the show comes back                                                          |
| `tvMessages.texts`                                                 | `{}` (the original words)          | Rewritten messages, e.g. `{"app_blocked": {"title": "No {app} right now"}}`. Keys and fields: `src/enforce/message-catalog.ts`. Easier in the dashboard |
| `rules.*`                                                          | none                               | See [§9](#9-rules-and-enforcement). Reloaded live when you save.                                                                                        |
| `enforcement.mode`                                                 | `dry-run`                          | `off` (evaluate only) · `dry-run` (log only) · `enforce`                                                                                                |
| `enforcement.cooldownSec` / `powerOffCooldownSec`                  | 10 / 15                            | Minimum gap between repeated Home / PowerOff presses                                                                                                    |
| `enforcement.escalation`                                           | `{ "repeats": 3, "windowMin": 5 }` | `repeats: 0` disables escalation                                                                                                                        |
| `http.port` / `http.host`                                          | 8090 / `0.0.0.0`                   | Dashboard address. Only the port usually matters.                                                                                                       |
| `http.lanOnly`                                                     | true                               | Reject non-LAN clients                                                                                                                                  |
| `http.sessionDays`                                                 | 30                                 | How long a dashboard sign-in lasts                                                                                                                      |
| `notifications.ntfy`                                               | disabled                           | `{ "enabled": true, "server": "https://ntfy.sh", "topic": "…" }`. Easier to set in the dashboard.                                                       |
| `notifications.events.*` / `unreachableAfterMin` / `includeDryRun` | all on / 30 / false                | Which alerts to send                                                                                                                                    |

## 16. Troubleshooting

| Symptom                                                | Fix                                                                                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The dashboard says "localhost refused to connect"      | Roku TV Parental Control isn't running. Run `npm run service:status`. If the app is "not answering", run `npm run service:restart` as administrator, and look at `logs/service/launcher.log` for what happened at start-up. |
| `discover` finds nothing                               | Check that the PC and TV are on the same network and VLAN, the firewall rule is in place (§7), and the network profile is **Private**. Try `npm run discover -- --scan`, or set `device.host`.                              |
| Health **restricted · limited**                        | TV: Control by mobile apps → Network access → **Enabled**                                                                                                                                                                   |
| Health **offline** while the TV is on                  | TV may have a new IP: the service rediscovers by serial automatically (SSDP, then subnet scan). A DHCP reservation avoids this.                                                                                             |
| Health flips to **offline** when the TV is turned off  | Turn on _Fast TV start_ (§2). Without it, the TV drops off the network in standby.                                                                                                                                          |
| Screen time looks low                                  | Time while the PC sleeps or the TV is unreachable is deliberately not counted. Keep the PC awake (§6).                                                                                                                      |
| `npm install` fails in `node-gyp rebuild` / "find VS"  | `.npmrc` is missing or was bypassed. Restore it, or run `npm install --ignore-scripts`. Delete `node_modules` first; close VS Code if you get EPERM errors while deleting.                                                  |
| Phone can't open the dashboard                         | Make sure the phone is on the home Wi-Fi (not mobile data or a guest network), the firewall rule from §10 is in place, and you're using the address `npm run status` shows                                                  |
| Dashboard says "Set a PIN on the PC first"             | Run `npm run set-pin -- <digits>` on the PC                                                                                                                                                                                 |
| Dashboard says "Dashboard not built"                   | Run `npm run build:web` (or `npm run build`)                                                                                                                                                                                |
| Channel icons are initials                             | The TV only hands out icons when _Control by mobile apps_ is **Enabled**. Icons are cached once fetched.                                                                                                                    |
| `channel:install`: "Developer mode looks switched off" | Turn developer mode on (§12, step 1) and make sure the TV is on. The installer listens on port 80 of the TV.                                                                                                                |
| `channel:install`: "rejected the developer password"   | Check `ROKU_DEV_PASSWORD` in `.env`. It's the password chosen when developer mode was turned on, not your Roku account password.                                                                                            |
| The TV jumps to Home without a message                 | Settings → TV messages should say "On the TV". If it doesn't, run `npm run channel:install`, or tap **Check again**.                                                                                                        |
| "Roku TV Parental Control is already running"          | The Windows service is running. Use it (and the dashboard), or `npm run service:stop` first.                                                                                                                                |
| The service keeps stopping                             | Look in `logs/roku-guardian.log` and `logs/service/`. Running `npm start` in a terminal shows startup errors directly.                                                                                                      |
| More detail                                            | PowerShell: `$env:LOG_LEVEL='debug'; npm run dev`, or set `"log": {"level": "debug"}`. Logs are in `logs/`.                                                                                                                 |

## 17. Known limitations

- The service can't tell **who** is watching, so there is one policy per TV.
- It can't filter content **inside** an app. Use each app's kid profiles for that.
- Enforcement takes effect within one poll interval (5 s).
- If someone sets _Control by mobile apps_ to **Disabled**, the TV can no longer be controlled. The service detects and flags this, with a notification. A Roku account PIN reduces the risk.
- A message can't be drawn over a show: the channel replaces it. So a warning interrupts what's playing, and some apps reopen at their own home screen afterwards.
- Pressing Home leaves a message screen. The rules still apply, so reopening a blocked app brings the message back, and repeated tries switch the TV off.
- Media-player state varies by channel and is best-effort. "Paused for an hour" still counts as watching.

## Windows installer and releases

`Install.cmd` (double-click; it asks for administrator rights) runs `scripts/windows/install.ps1`, which works on Windows PowerShell 5.1, so nothing extra is needed. If it was opened from inside the zip without extracting, it says so and stops. The steps:

1. installs Node.js LTS if it is missing (winget, falling back to the MSI from nodejs.org);
2. copies the app to `C:\RokuTVParentalControl`, never overwriting `config.json`, `.env`, `data\` or `logs\`; it also moves settings and history over from an older install, including the earlier "Roku Guardian" service, which it removes;
3. from a source download, runs `npm ci` and `npm run build`; a release zip (it has a `RELEASE` file) is already built;
4. adds the firewall rule for the dashboard, and offers to mark a Public Wi-Fi profile as Private;
5. offers to keep the PC awake while plugged in (`powercfg`);
6. runs the setup wizard (`node dist/src/cli/index.js setup --installer`);
7. installs or restarts the Windows service (`node dist/src/cli/service.js ensure`), waits for `/api/health`;
8. adds shortcuts (the dashboard on the desktop and in the Start menu; in the Start menu also _Open it on a phone_, _Run setup again_ and _Uninstall_), opens the dashboard and prints the phone QR code.

Running it again updates in place and keeps everything; _Run setup again_ is `C:\RokuTVParentalControl\Install.cmd` itself. Inside the installer, the wizard numbers its questions as parts of step 6 and prints `OK` rather than `✓` (Windows 10's console font has no ✓). `Uninstall.cmd` removes the service, the firewall rule and the shortcuts, and asks before deleting the folder.

**Releases.** Pushing a tag like `v1.0.0` runs `.github/workflows/release.yml` on a Windows runner: checks, build, `npm prune --omit=dev`, then `Roku-TV-Parental-Control-Windows.zip` (no top-level folder) with `dist/`, `web/dist/`, production `node_modules/`, the channel source, the scripts and a `RELEASE` marker, attached to a **draft** release. Publish it after trying the zip on a Windows PC. The file name never changes, because the README links to `releases/latest/download/Roku-TV-Parental-Control-Windows.zip`.

better-sqlite3 and @node-rs/argon2 are Node-API binaries, so the zip runs on any Node 22 or newer. better-sqlite3 bundles every platform's binary; for @node-rs/argon2 the workflow adds the `win32-arm64-msvc` package next to the runner's x64 one, so Windows on ARM works too (untested). Update `version` in `package.json` and `src/app.ts` (`VERSION`) before tagging (the workflow checks the tag matches), and `build_version` in `roku-channel/manifest` when the channel changes. `.github/workflows/ci.yml` runs the tests on Node 22 and 24, and on Windows checks the build and that the installer scripts parse in Windows PowerShell 5.1.

## Development

See also [CONTRIBUTING.md](../CONTRIBUTING.md).

```powershell
npm test            # vitest: unit + integration (spins up mock TVs on random ports)
npm run check       # typecheck (service + dashboard) + lint + tests
npm run build:web   # build the dashboard into web/dist (served by the service)
npm run dev:web     # dashboard dev server on :5173 with hot reload; proxies /api to a running service
npm run format      # prettier
```

The TV channel (`roku-channel/`) is BrightScript/SceneGraph. To check it after editing: `npx -y brighterscript --project roku-channel/bsconfig.json` (validation only; nothing is added to the project). Bump `build_version` in `roku-channel/manifest`, then `npm run channel:install`. The artwork is rendered from the SVGs in `roku-channel/art/` (`render.py` explains how).
