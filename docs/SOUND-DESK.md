# Front of House (sound desk page)

`http://192.168.1.100:8080/sound/` shows three things side by side:

| | |
|---|---|
| **Level** | Live SPL from Open Sound Meter: the big number (dB(A), Slow by default), a bar meter with amber and red marks, **Leq 15 min**, **Leq 1 min** and **Max 1 min**. |
| **Spotify** | What's playing on the church account, with ⏮ ⏯ ⏭, a volume slider, a playlist picker and a "play on" device picker. |
| **Order of service** | The same live view as the dashboard: leaders, keys, and live item timing. |

To save it as its own app: in Chrome, open the **⋮ menu**, choose **Cast, save, and share**, then **Install page as app…**.

## Choosing the tools

Go to **Admin → Settings → Sound desk** and tick what you want:
- **Level meter**
- **Spotify**
- **ProPresenter timers**
- **Recording & stream** (HyperDeck and OBS)
- **Order of service**
- **Mic & IEM assignments**

The small tools stack on the left. The order of service and the mic list fill the right.

To give one computer a different set, use a link such as `/sound/?tools=level,spotify,order`.

The header can show the same countdown to the next service time as Backstage (Admin → Settings → Front of House → *Show countdown to the next service time*). One computer can override it with `?countdown=0` or `?countdown=1`.

---

## Open Sound Meter (v1.4.x)

1. In **Open Sound Meter**, open the **Remote** panel from the sidebar and tick **Server**.
2. In Backstage, go to **Admin → Settings → Open Sound Meter**:
   - Tick **Listen for Open Sound Meter**.
   - Optionally set the **measurement** name to show, e.g. `Measurement 1`. If you leave it blank, Backstage uses the first one it finds.
   - Choose the weighting and speed: **A / Slow** for overall level, **C** if you care about low end.
   - Set **Amber at** and **Red at** (default 95 and 100 dB).
   - Click **Save**. Within a few seconds, the status line says *Receiving "…" from …*.

**How it works:** Open Sound Meter announces itself and sends its levels over the local network on **UDP port 49007**, multicast group `239.255.42.42`. Backstage listens for these, so it needs no IP address. The number matches Open Sound Meter's own SPL readout (dBFS + 140, plus any offset you set). Leq is calculated by Backstage from one reading per second.

**Requirements:**
- The Mac running Open Sound Meter and the NAS must be on the **same network/VLAN**. Multicast doesn't cross routers.
- On the NAS, Backstage must use **host networking**. That's the `network_mode: host` line in `deploy/synology/docker-compose.yml`.
- If **"Waiting for Open Sound Meter…"** never changes:
  - Check that **Server** is ticked in Open Sound Meter.
  - Check the DSM firewall (allow UDP 49007).
  - Check whether your UniFi network blocks multicast between devices. Look at *IGMP snooping* and *Multicast Enhancement* in the UniFi network settings for that VLAN.

---

## Spotify

**Playback control needs Spotify Premium.** Spotify blocks remote control on free accounts. Without Premium, now-playing still shows, but the buttons won't work.

One-time setup, about 5 minutes, in **Admin → Settings → Spotify**:
1. Go to <https://developer.spotify.com/dashboard>, sign in with the church's Spotify account, and click **Create app**:
   - **Name:** anything, e.g. "Backstage".
   - **APIs:** tick **Web API**.
   - **Redirect URI:** `http://127.0.0.1:8888/callback`, typed exactly.
   - Save.
2. Copy the app's **Client ID** into Backstage and click **Connect Spotify**. Sign in and click **Agree**.
3. Your browser lands on a page that **won't load**. That's expected. Spotify only allows `http` return addresses on 127.0.0.1, and nothing runs there. Copy the **whole address** from the address bar, paste it into Backstage, and click **Finish**.

Backstage keeps itself signed in from then on.

**Using the controls:**
- To use ⏮ ⏯ ⏭, volume, playlists and devices, the sound desk computer must be **signed in to Backstage admin** in that same browser or app. Anyone else can watch the page, but only signed-in users can control playback.
- Spotify controls whichever device is **active**: the Spotify app on the sound desk Mac, a speaker, and so on. If it says "No Spotify device is active", open Spotify on the sound desk Mac, or pick a device in **Play on…**.
- To start the pre-service music, choose your **Pre-Service** playlist and click **Play**.
