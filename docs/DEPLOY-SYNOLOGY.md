# Installing Green Room on a Synology NAS

A Synology NAS is a good home for Green Room. It's always on, it's on the church network next to ProPresenter, and it backs itself up. Green Room runs in **Container Manager**, Synology's built-in tool for running Docker containers. You don't need a Mac, Xcode or Terminal.

```
  ┌──────────────────── church network ─────────────────────┐
  │  Greenroom TV ──┐                                        │
  │  Admin laptop ──┼──http──▶  Synology NAS ──▶ ProPresenter Mac (timers)
  │  Phone on Wi-Fi ┘           (Container Manager)          │
  └────────────────────────────────┼─────────────────────────┘
                                   └──HTTPS──▶ Planning Center (internet)
```

Allow about 20 minutes.

## 1. Check the NAS

1. Sign in to DSM, then open **Package Center** and search for **Container Manager**.
   - If it's listed, install it.
   - If it's missing, this model can't run containers. Use the Mac guide ([DEPLOY-MAC.md](DEPLOY-MAC.md)) instead.
   - Container Manager needs DSM 7.2 or later. Older DSM versions call it *Docker*; the steps are similar.
2. **Give the NAS a fixed address.** You'll type it into the TVs, so it shouldn't change. Either:
   - go to *Control Panel → Network → Network Interface → Edit* and set a manual IP, or
   - ask whoever runs the router for a DHCP reservation.

## 2. Copy Green Room to the NAS

1. Download the code as a ZIP. On a computer signed in to GitHub, open:
   `https://github.com/gpproduction/greenroomdashboard/archive/refs/heads/claude/brave-feynman-7mpjir.zip`
2. In DSM open **File Station**. Installing Container Manager created a shared folder called **docker**. Inside it, upload the ZIP.
3. Right-click the ZIP → **Extract → Extract here**.
4. Rename the extracted folder to **`greenroom`**. You should now have `docker/greenroom/docker-compose.yml`.
5. Inside `docker/greenroom`, create an empty folder named **`data`**. Your settings and assignments are saved here.

## 3. Start it

1. Open **Container Manager → Project → Create**.
2. Fill in:
   - **Project name:** `greenroom`
   - **Path:** `/docker/greenroom`
   - **Source:** *Use existing docker-compose.yml*
3. Click **Next**. If it offers a Web Station portal, skip it. Then click **Done**.

The NAS builds Green Room the first time, which takes a few minutes, and then starts it. In **Container**, `greenroom-dashboard` should show as running (healthy). It restarts by itself after a reboot or a power cut.

> **Port 8080 already in use?** Edit `docker-compose.yml` in File Station: change `"8080:8080"` to, for example, `"8090:8080"`, then use 8090 in the addresses below.
>
> **DSM firewall turned on?** Allow the port under *Control Panel → Security → Firewall → Edit Rules*.

## 4. Set it up

Open `http://<nas-ip>:8080/admin` from any computer on the church network.

1. **Choose the admin password.**
2. **Settings → Planning Center**:
   - Create a Personal Access Token at <https://api.planningcenteronline.com/oauth/applications>.
   - Paste the Application ID and Secret, then click **Test & connect**.
   - Tick **Sunday Morning** (and any others), tick and order the teams, then click **Save**.
3. **Settings → ProPresenter**:
   - On the ProPresenter Mac, open ProPresenter → Settings → Network, tick **Enable Network**, and note the IP address and port.
   - Enter them here, click **Test connection**, choose the timers, then click **Save**.
4. **Devices**: add your mics and IEMs, then pair them (**Pair mics and IEMs by list order**).
5. **Assign**: assign this week's people.

## 5. Greenroom TVs

Point each TV's computer at:

```
http://<nas-ip>:8080/dashboard/
```

To run it full screen and start automatically, use the Chrome kiosk commands in the [README](../README.md#running-chrome-in-kiosk-mode).

## Updating

1. Download the new ZIP (step 2.1) and extract it on your computer.
2. In File Station, upload its contents into `docker/greenroom` and choose **Overwrite**. Don't delete the `data` folder.
3. In **Container Manager → Project → greenroom**:
   - click **Action → Stop**;
   - then **Action → Build** (this rebuilds with the new code);
   - then **Action → Start** if it didn't start by itself.

Open dashboards reload themselves when the new version starts.

## Backups

Everything lives in `docker/greenroom/data/db.json`. Include the `docker` shared folder in **Hyper Backup**, or copy that one file somewhere safe now and then.

## Troubleshooting

- **Container keeps restarting or shows unhealthy**: in *Container Manager → Container → greenroom-dashboard → Log*, read the last lines.
- **Can't open the page**:
  - Check that you're on the church network and the port matches `docker-compose.yml`.
  - Check the DSM firewall.
- **"ProPresenter did not respond"**:
  - Make sure ProPresenter is open with *Enable Network* ticked.
  - Check that its IP address hasn't changed. A fixed IP for the ProPresenter Mac fixes that for good.
  - Some networks keep Wi-Fi devices from talking to wired ones. If so, the NAS and ProPresenter need to be on the same part of the network.
- **Planning Center errors**: re-check the token with *Test & connect*. The NAS needs internet access.
