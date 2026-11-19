# GrowPoint Backstage

A self-hosted mic and in-ear-monitor assignment board for church production teams.

- **Planning Center Services**: pulls the current or next plan, with its order of service (including each item's leader), service times, and scheduled team members with their Planning Center photos.
- **Other devices**: a third slot for acoustic packs, instrument mics, DIs and so on, shown as a plain chip on the dashboard.
- **Show on dashboard**: a per-person checkbox on the Assign page. Worship Team shows everyone by default (set per team in Settings), and anyone with a device always shows, so instrumentalists appear with their position even without a mic.
- **Assignments**: you assign wireless mics and IEMs to each person in the admin backend. Each mic can be linked to an IEM, so picking the mic brings its IEM along, and you can still change the IEM on its own. Each person's last choice is remembered and pre-fills future plans. Only people with something assigned appear on the board.
- **ProPresenter 7**: shows live timers and highlights the item that's currently on screen.
- **Live item timing** (like Services LIVE): when an item goes live in ProPresenter, the dashboard counts how long you've been on it (planned vs actual, plus a running service total). Actual times are saved per service time, and only during Planning Center *service* times, never rehearsals. Admin → Assign shows a planned-vs-actual report. Try it with `DEMO=1 DEMO_LIVE=1 npm start`.
- **HyperDeck & OBS**: the dashboard footer shows HyperDeck record status and timecode (Ethernet control, port 9993) and OBS stream and record time (OBS WebSocket server, port 4455), next to the connection icons.
- **Front of House** (`/foh` or `/sound/`): live SPL and Leq from Open Sound Meter, Spotify now-playing and controls, and the order of service. See [docs/SOUND-DESK.md](docs/SOUND-DESK.md).
- **UniFi Access arrivals**: people who badged in today get a green "Arrived" (with the time) on the dashboard. Door unlocks come from the UniFi Access API (port 12445) and are matched to Planning Center names.
- **Themes**: **GrowPoint** (navy), **Planning Center Dark** or **Planning Center Light**, chosen separately for Backstage and Front of House (Admin → Settings → Screens), or per screen with `?theme=pco-dark|pco-light|growpoint`.
- **Announcements box**: pulled from Planning Center (the descriptions of announcement items and/or plan notes), shown under the timers on Backstage and as a Front of House tool. While it's on, it can take the details out of the order of service.
- **History** (Admin → History): every recorded service, with planned vs actual per item for each service time, trends for recurring items over recent weeks, and CSV export for Excel or Google Sheets. A copy of each plan is saved with its times, so history survives later edits in Planning Center.
- **Production test mode** (Admin → Live): click through ProPresenter outside service times to check item timing. It's recorded separately from real services.
- **Announcements**: the description from Planning Center is shown under announcement items (configurable).
- **Song notes**: a song's Planning Center description ("Tag the bridge 2x") shows in amber under the song, plus any item-note columns you choose.
- **Service starting alarm**: a flashing red bar across the top of Backstage counts down the last 2 minutes (configurable) before each service time. Preview it with `/backstage?alarm=preview`.
- **Dashboard**: a full-screen page for Chrome on a greenroom TV. It updates live over a WebSocket, reconnects by itself, and reloads itself when the server is updated.

```
 Planning Center (cloud) ──HTTPS──┐
                                   ▼
                     ┌──────────────────────────┐        ┌──────────────┐
 ProPresenter ◀─LAN──│  Backstage server (Node) │──WS──▶ │ Chrome on TV │
   (timers)          │  /admin   /dashboard      │        └──────────────┘
                     └──────────────────────────┘
```

The server **must run on the church network**, because ProPresenter's API is only reachable locally. Any device on the church network (including Wi-Fi) can open it.

**Installing at church:**
- **Synology NAS** (recommended): [docs/DEPLOY-SYNOLOGY.md](docs/DEPLOY-SYNOLOGY.md). It runs in Container Manager, with no Terminal needed.
- **Mac**: [docs/DEPLOY-MAC.md](docs/DEPLOY-MAC.md).
- **Automatic updates** (GitHub Actions builds an image, and a Watchtower updater on the NAS installs it): [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md).

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run demo        # sample data, no accounts needed → http://localhost:8080
```

For real use:

```bash
cp .env.example .env    # optional: set ADMIN_PASSWORD, PCO_APP_ID, PCO_SECRET
npm start
```

Or with Docker (this is also what the Synology setup uses):

```bash
docker compose up -d --build
```

Data (settings, devices and assignments) is stored in `./data/db.json`. Back up that one file.

## Setup

1. Open `http://<server-ip>:8080/admin`. On the first visit you choose the admin password, unless `ADMIN_PASSWORD` was set.
2. **Settings → Planning Center**:
   - Create a Personal Access Token at <https://api.planningcenteronline.com/oauth/applications>. Use an account that can see Services.
   - Paste the Application ID and Secret, then click **Test & connect**.
   - Tick the service types to pull from (e.g. Sunday Morning).
   - Tick the teams to show on the dashboard (e.g. Worship Team, Production Team, Choir) and put them in order.
   - The leader shown for each order-of-service item comes from an item note column. Yours is **Lead**; you can change this in Settings.
   - Save.
3. **Settings → ProPresenter**:
   - In ProPresenter 7 go to *Settings → Network*, tick *Enable Network*, and note the IP and port.
   - Enter the IP and port here, click **Test connection**, and choose which timers to show.
   - Save.
4. **Devices**: add your mics and IEMs, with name, channel and frequency. Link each mic to its IEM in the *Linked IEM* column, or click **Pair mics and IEMs by list order**.
5. **Assign**: pick a plan and choose a mic and an IEM per person.
   - Choices save instantly and remember each person.
   - Picking a mic also picks its linked IEM, unless that person already has a different IEM. Picking only an IEM (e.g. for a drummer) never adds a mic.
   - Only people with a mic or IEM appear on the dashboard.
   - Conflicts (the same device given to two people) are flagged in red, both here and on the dashboard.
   - Use *Add someone not in Planning Center* for guests.

## The dashboard on a TV

The dashboard lives at `http://<server-ip>:8080/dashboard/`. These URL options can be combined:

| URL | Shows |
|---|---|
| `/dashboard/` | Mic/IEM roster, timers and order of service |
| `/dashboard/?layout=timers` | Big timers only |
| `/dashboard/?layout=order` | Order of service only |
| `/dashboard/?layout=roster` | Roster only |
| `/dashboard/?teams=Worship Team,Choir` | Only those teams |
| `&scale=1.3` | Bigger text for a far-away screen |

### Saving it as a desktop app

Backstage has app icons and names, so Chrome can open it in its own window, with a Dock or taskbar icon and no address bar:

1. Open `http://<server-ip>:8080/dashboard/`, or `/admin/` for the admin app.
2. In Chrome, open the **⋮ menu** and choose **Cast, save, and share**. Then choose **Install page as app…** or, on older Chrome, **Create shortcut…** and tick **Open as window**.

Chrome's install button in the address bar only appears on `https://` sites. On the church network (`http://`), use the menu above. The result is the same.

### Running Chrome in kiosk mode

Kiosk mode opens Chrome full screen with no browser controls. Add this command to the TV computer's startup items:

```bash
# Windows (shortcut target)
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-session-crashed-bubble --incognito http://SERVER-IP:8080/dashboard/

# macOS
open -a "Google Chrome" --args --kiosk --noerrdialogs --incognito http://SERVER-IP:8080/dashboard/

# Linux / Raspberry Pi
chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble --incognito http://SERVER-IP:8080/dashboard/
```

### How the dashboard stays fresh

- Changes are pushed instantly over a WebSocket. If the connection drops, the page retries with backoff and also polls every 15 seconds.
- When the server restarts, every open dashboard reloads itself to pick up new code.
- An optional full reload runs every N hours (default 6), set in *Settings → Dashboard display*.
- If Planning Center is down, the last good plan stays on screen.
- Disable screen sleep and screensavers on the TV computer. Browsers won't let a plain-`http` page keep the screen awake.

## How it decides which plan to show

In **Automatic** mode, the dashboard shows the soonest plan across the selected service types. It moves to the next plan 2 hours after the last service time ends. You can also pin a specific plan in Settings.

## Development

```bash
npm run dev    # restarts on file changes
npm test
```

```
server/
  index.js         HTTP routes + WebSocket broadcast
  pco.js           Planning Center Services API client
  sync.js          polling loop, active-plan selection, cache
  propresenter.js  ProPresenter 7 API poller (timers, active presentation)
  roster.js        merges plan people + devices + assignments, detects conflicts
  live.js          live item timing (ProPresenter → plan item, service-time windows)
  history.js       past services: planned vs actual, trends, CSV
  announcements.js announcements from plan items / plan notes
  media.js         HyperDeck (TCP 9993) + OBS (obs-websocket v5) status
  unifi.js         UniFi Access door arrivals matched to Planning Center names
  osm.js           Open Sound Meter levels (UDP multicast 49007) + Leq
  spotify.js       Spotify now playing + controls (PKCE)
  store.js         JSON file persistence
  env.js           loads .env before anything else
  auth.js          admin password + sessions
  demo.js          sample data for DEMO=1
public/
  dashboard/       TV display (no build step)
  admin/           admin backend UI (no build step)
```

## Security notes

- The dashboard is read-only and open to anyone on the network. Everything under `/api/admin` requires the admin password.
- The Planning Center secret is stored in `data/db.json`, or comes from `PCO_SECRET` in the environment. Keep the server on a trusted network.
- Backstage is meant for the church network only. Don't forward port 8080 on the router.
- Admin logins persist across restarts (stored hashed in `data/db.json`). Changing the admin password signs out every other device.
