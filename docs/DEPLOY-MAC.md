# Installing Green Room on the church Mac

This guide sets up Green Room on a Mac at church. Everything runs on the church network, which ProPresenter requires:

```
  ┌──────────────────── church network ─────────────────────┐
  │                                                          │
  │  Greenroom TV ──┐                                        │
  │  Admin laptop ──┼──http──▶  Green Room Mac ──▶ ProPresenter Mac (timers)
  │  Phone on Wi-Fi ┘                │                       │
  └──────────────────────────────────┼───────────────────────┘
                                     └──HTTPS──▶ Planning Center (internet)
```

Any computer, tablet or phone **on the church network** (including church Wi-Fi) can open the dashboard and admin. Green Room isn't reachable from outside the building.

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

Point each TV's computer at the Green Room Mac's address:

```
http://<green-room-mac-ip>:8080/dashboard/
```

To run it full screen and start automatically, use the Chrome kiosk commands in the main [README](../README.md#running-chrome-in-kiosk-mode).

---

## Day-to-day

| Task | How |
|---|---|
| Update to the latest version | `~/greenroom/deploy/macos/update.sh`. It backs up your data, updates and restarts. Open dashboards reload themselves. |
| See if it's running | Open `http://localhost:8080/api/health` on the Mac |
| Logs | `~/greenroom/logs/greenroom.log` |
| Restart | `sudo launchctl kickstart -k system/church.growpoint.greenroom` |
| Back up | Copy `~/greenroom/data/db.json`. Time Machine covers it too. `update.sh` also keeps the last 20 copies in `data/backups/`. |
| Remove | `~/greenroom/deploy/macos/uninstall.sh` (keeps your data) |

### Troubleshooting

- **Dashboard says "Waiting for Planning Center…"**: check Admin → Settings → Planning Center → *Test & connect*, and make sure at least one service type is ticked.
- **Timers say "ProPresenter did not respond"**:
  - Make sure ProPresenter is open and *Enable Network* is ticked.
  - Check that the IP address hasn't changed. A DHCP reservation for the ProPresenter Mac fixes that for good.
  - Check that both Macs are on the same network.
- **A TV or phone can't load the page**: make sure it's on the church network (not cellular or guest Wi-Fi that's isolated from other devices), and that the Green Room Mac is on. Check `http://localhost:8080/api/health` on the Mac itself.
- **The installer says it can't run from Documents/Desktop**: move the folder to your home folder (`mv ~/Documents/greenroom ~/greenroom`) and run the installer again.
