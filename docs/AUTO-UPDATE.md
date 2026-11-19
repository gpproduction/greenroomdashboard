# Automatic updates on the Synology

Once this is set up, you never upload files again. It works like this:

1. A change is pushed to GitHub.
2. **GitHub Actions** runs the tests, builds Backstage, and publishes it to GitHub's container registry (`ghcr.io/gpproduction/greenroomdashboard`). This takes about 3 minutes.
3. On the NAS, a small **updater** container (Watchtower) checks for a new version every 15 minutes, **Monday–Saturday, 1 AM–5 PM**. It never runs during Sunday services or evening rehearsals.
4. When it finds one, it swaps in the new version within a few seconds. Open dashboards reload themselves.

Admin → **Settings → Updates** also has an **Install updates now** button.

---

## One-time setup (about 15 minutes)

### 1. Check that the first build finished

On GitHub, open the repository, go to **Actions**, and look at **Build & publish image**. The latest run should have a green check.

### 2. Let the NAS download the image

The repository is private, so the published image (the "package") starts out private too. Pick **one** option.

**Option A: make the package public (recommended, simplest)**
1. Signed in as **gpproduction**, open <https://github.com/gpproduction?tab=packages>, click **greenroomdashboard**, then **Package settings** (on the right).
2. Under **Danger Zone**, click **Change visibility** and choose **Public**.

Your **source code stays private**; only the ready-to-run app becomes downloadable. It contains no passwords or keys. Those live only in the NAS's `data` folder.

**Option B: keep the package private**
1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**. Tick only **read:packages**.
2. On the NAS, go to **Container Manager → Registry → Settings → Add** and add `https://ghcr.io` with your GitHub username and that token.
3. In step 3 below, remove the `#` from the `REPO_USER` / `REPO_PASS` lines and fill them in. The updater needs the token too.

### 3. Switch the NAS project over

Your settings and assignments in `docker/greenroom/data` are kept.

1. **Container Manager → Project → greenroom**: click **Action → Stop**, then **Action → Delete**. This removes the project, not your files.
2. **Container Manager → Container**: if `greenroom-dashboard` is still listed, select it and click **Delete**.
3. **Container Manager → Project → Create**:
   - **Project name:** `greenroom`
   - **Path:** `/docker/greenroom` (the same folder as before)
   - **Source:** *Create docker-compose.yml*. Paste the contents of [`deploy/synology/docker-compose.yml`](../deploy/synology/docker-compose.yml). If it says a docker-compose.yml already exists, replace it.
   - Click **Next**, skip Web Station, then click **Done**.
4. It downloads the image (no build step this time) and starts two containers: **greenroom-dashboard** and **greenroom-updater**.

### 4. Check it

Open `http://192.168.1.100:8080/admin`:
- The header shows the version and build, e.g. **v0.8.0 · 1a2b3c4**.
- **Settings → Updates** says automatic updates are on.

## Changing the NAS setup file later

The updater installs new **app** versions, but it doesn't change the project's YAML. When a release changes the YAML, do this once:
1. **Container Manager → Project → greenroom → Action → Stop**.
2. Click **Edit** (or *YAML configurations*), paste the new [`deploy/synology/docker-compose.yml`](../deploy/synology/docker-compose.yml), and save.
3. Click **Action → Build**, then **Start**.

For example, v0.9.0 switches Backstage to `network_mode: host` so it can hear Open Sound Meter.

## Troubleshooting

- **"denied" or "unauthorized" when the project starts.** The package is still private. Do step 2, option A or B.
- **The updater never updates.** Check **Container → greenroom-updater → Log**. Updates only run Monday–Saturday, 1 AM–5 PM, so use **Install updates now** to test.
- **To pause updates for a while:** stop the **greenroom-updater** container. Start it again to resume.
- **To go back to the previous version:** each build is also tagged with its commit. In the project's YAML, change `:latest` to `:<commit>` (the full commit ID from GitHub), then click **Build** / **Start**. Change it back to `:latest` to resume updates.
