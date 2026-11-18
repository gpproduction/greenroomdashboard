# Installing Green Room on the church Mac

This guide sets up Green Room on a Mac at church so that:

- Greenroom TVs **inside the building** load it straight over the church network. This keeps working even if the internet is down.
- Staff and volunteers can open it **from anywhere** at a web address like `https://greenroom.yourdomain.com`. Before they get in, they sign in with their `@growpoint.church` email.
- ProPresenter timers work, because the server sits on the same network as ProPresenter.

```
                         Internet
  phone / laptop ──HTTPS──▶ Cloudflare (sign-in check) ──tunnel──┐
                                                                 │  (outbound only,
  ┌────────────── church network ─────────────────────────────── │   no router changes)
  │                                                              ▼
  │  Greenroom TV ──http──▶  Green Room Mac (server + cloudflared)
  │                                    │
  │                                    └──▶ ProPresenter Mac (timers)
  └───────────────────────────────────────────────────────────────
```

Allow about 45 minutes the first time.

---

## 1. Prepare the Mac

Use any Mac that can stay on all the time, such as a Mac mini. It can be the ProPresenter Mac, but a separate one is better.

1. **Always on.** The installer offers to set this up for you (step 2). To do it by hand: System Settings → Energy, turn on *Prevent automatic sleeping* and *Start up automatically after a power failure*.
2. **Fixed address.** Ask whoever manages the church router to give this Mac a **DHCP reservation**, so its IP address never changes. The TVs and ProPresenter settings depend on that address.
3. **Install Node.js.** Download the **LTS** installer from <https://nodejs.org> and run it.
4. **Install git** so you can download and update Green Room. Open Terminal and run:

   ```bash
   xcode-select --install
   ```

   Click *Install* in the window that appears.

## 2. Install Green Room

In Terminal, run these commands. They put the app in your home folder. **Don't** use Documents, Desktop or Downloads, because macOS blocks background services from those folders.

```bash
cd ~
```
```bash
git clone -b claude/brave-feynman-7mpjir https://github.com/gpproduction/greenroomdashboard.git greenroom
```
```bash
~/greenroom/deploy/macos/install.sh
```

The installer:
- installs what the app needs;
- sets Green Room up as a **background service** that starts at boot, with no login needed;
- restarts it if it ever crashes;
- offers to set the power options from step 1.

It asks for your Mac password once. When it finishes, it prints the Admin and Dashboard links.

> If GitHub asks you to sign in, the repository is private. Use a GitHub account that has access, or ask for a ZIP download instead.

## 3. First-time setup

Open the Admin link from the installer, e.g. `http://192.168.1.20:8080/admin`.

1. **Choose the admin password.**
2. **Settings → Planning Center**:
   - Create a Personal Access Token at <https://api.planningcenteronline.com/oauth/applications>.
   - Paste the Application ID and Secret, then click **Test & connect**.
   - Tick **Sunday Morning** (and any other service types you want).
   - Tick the teams to show (Worship Team, Production Team, …), then click **Save**.
3. **Settings → ProPresenter**:
   - On the ProPresenter Mac, open ProPresenter → Settings → Network, tick **Enable Network**, and note the IP address and port.
   - Enter them here, click **Test connection**, tick the timers you want, then click **Save**.
4. **Devices**: add your mics and IEMs, then click **Pair mics and IEMs by list order**, or set the links one by one.
5. **Assign**: assign this Sunday's people.

## 4. Greenroom TVs (inside the building)

Point each TV's computer at the **local** address, not the internet one, so it keeps working without internet:

```
http://<green-room-mac-ip>:8080/dashboard/
```

To run it full screen and start automatically, use the Chrome kiosk commands in the main [README](../README.md#running-chrome-in-kiosk-mode).

---

## 5. Access from anywhere with Cloudflare

Cloudflare Tunnel makes a secure, outgoing-only connection from the Mac to Cloudflare. Nothing on the church router needs to change. Cloudflare Access then makes everyone sign in before they reach the app.

**Cost:** the tunnel and Access are free for up to 50 users. You only pay for a domain.

### 5a. Get a domain on Cloudflare

Cloudflare can only publish addresses on a domain whose DNS it manages. growpoint.church's DNS is managed through WP Engine, and moving it could disrupt the church website and email. So use a **separate, inexpensive domain** just for this:

1. Create a free account at <https://dash.cloudflare.com>. A shared production or tech login works well.
2. Go to **Domain Registration → Register Domains** and buy a domain, e.g. `growpointprod.com`. This is about $10 a year at cost price.

> Later, if the church moves growpoint.church's DNS to Cloudflare, you can use `greenroom.growpoint.church` instead. Only the hostname in step 5c changes.

### 5b. Create the tunnel

1. In the Cloudflare dashboard open **Zero Trust**. The first visit asks you to pick a team name and the **Free** plan.
2. Go to **Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it `greenroom`.
3. On the *Install connector* screen, choose **macOS**. Cloudflare shows a command ending in a long token, like `sudo cloudflared service install eyJh…`. Copy **only the token**.
4. On the Green Room Mac, run:

   ```bash
   ~/greenroom/deploy/macos/setup-tunnel.sh eyJh...your-token...
   ```

   Within a minute, the tunnel shows as **Healthy** in the dashboard.

### 5c. Publish Green Room

Still in the tunnel's settings, add a **Public hostname**:

| Field | Value |
|---|---|
| Subdomain | `greenroom` |
| Domain | your domain from 5a |
| Service type | `HTTP` |
| URL | `localhost:8080` |

Save. Don't open the address yet. Lock it down first (5d).

### 5d. Require a sign-in

1. In Zero Trust go to **Access → Applications → Add an application → Self-hosted**.
2. Set the application domain to `greenroom.<your domain>`. Leave the path empty so the whole site is protected.
3. Add a policy:
   - **Action:** Allow
   - **Include → Emails ending in:** `@growpoint.church`
   - To let in specific outside people, add another include rule: **Emails →** their addresses.
4. Save.

By default, people sign in with a **one-time code emailed to them**. That needs no extra setup and works right away.

**Optional: sign in with Google Workspace instead.** This makes the sign-in page show a *Sign in with Google* button for `@growpoint.church` accounts. It needs a Google Workspace admin:

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project.
2. Configure the **OAuth consent screen** as **Internal**.
3. Create an **OAuth client ID** of type *Web application*:
   - **Authorized JavaScript origin:** `https://<your-team-name>.cloudflareaccess.com`
   - **Authorized redirect URI:** `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
4. In Cloudflare Zero Trust, go to **Settings → Authentication → Login methods → Add new → Google Workspace**. Paste the client ID and secret, and enter `growpoint.church` as the domain.
5. In your Access application, turn on Google Workspace as a login method. You can turn off one-time PIN if you like.

Cloudflare sometimes renames these menus. If a label doesn't match exactly, look for the nearest equivalent.

### 5e. Try it

Open `https://greenroom.<your domain>/admin` on your phone with Wi-Fi turned off:

1. Cloudflare's sign-in page appears first.
2. Then you see the Green Room admin password screen.

Those are two separate locks, so a leaked admin password alone isn't enough to get in.

---

## Day-to-day

| Task | How |
|---|---|
| Update to the latest version | `~/greenroom/deploy/macos/update.sh`. It backs up your data, updates and restarts. Open dashboards reload themselves. |
| See if it's running | Open `http://localhost:8080/api/health` on the Mac |
| Logs | `~/greenroom/logs/greenroom.log` |
| Restart | `sudo launchctl kickstart -k system/church.growpoint.greenroom` |
| Back up | Copy `~/greenroom/data/db.json`. Time Machine covers it too. `update.sh` also keeps the last 20 copies in `data/backups/`. |
| Remove | `~/greenroom/deploy/macos/uninstall.sh` (keeps your data) and `sudo cloudflared service uninstall` |

### Troubleshooting

- **Dashboard says "Waiting for Planning Center…"**: check Admin → Settings → Planning Center → *Test & connect*, and make sure at least one service type is ticked.
- **Timers say "ProPresenter did not respond"**:
  - Make sure ProPresenter is open and *Enable Network* is ticked.
  - Check that the IP address hasn't changed. A DHCP reservation for the ProPresenter Mac fixes that for good.
  - Check that both Macs are on the same network.
- **The internet address shows a Cloudflare error 1033 or 502**: the tunnel or the app is down on the Mac. Check `http://localhost:8080/api/health`, and check the tunnel's status in Zero Trust → Networks → Tunnels.
- **The installer says it can't run from Documents/Desktop**: move the folder to your home folder (`mv ~/Documents/greenroom ~/greenroom`) and run the installer again.
