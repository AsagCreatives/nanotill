# Nano Tech: booking page + admin panel (Netlify)

```
public/                  the pages (start page + booking, admin panel, icons)
netlify/functions/       api.mjs (everything the pages talk to)  tick.mjs (runs every 10 minutes)
netlify/lib/blobstore.mjs   saves data in Netlify Blobs (built into Netlify, nothing to set up)
lib/core.cjs             all the app's logic
netlify.toml, package.json  Netlify settings
server.js, lib/filestore.cjs, Dockerfile   only for running on your own server instead (see the end)
```

## Put it live on Netlify
1. **Put the folder on GitHub.** Make a free account at github.com, create a **private** repository, then drag the *contents* of this folder into it
   (Add file > Upload files). Netlify needs the files from GitHub (a plain drag-and-drop deploy does not install what the functions need).
2. **Create the site.** At app.netlify.com choose **Add new site > Import an existing project**, pick GitHub and the repository. Leave the build settings as they are
   (Netlify reads `netlify.toml`) and click **Deploy**.
3. **Add your settings** *before the first visit*: Site configuration > **Environment variables**. Add:

   | Name | Value |
   |---|---|
   | `SETUP_CODE` | a code you choose (used once to create the admin account) |
   | `RESEND_API_KEY` | your **new** Resend key |
   | `MAIL_FROM` | `Nano Tech <receipts@your-domain.com>` (an address on a domain verified in Resend) |
   | `SLACK_WEBHOOK_URL` | your **new** Slack webhook URL (or paste it later in Settings) |
   | `CHECKIMEI_API_KEY` | your checkimei API access key (or paste it later in Settings) |
   | `TZ_NAME` | `Europe/London` (default) |

   Then **Deploys > Trigger deploy** so the settings are picked up.
4. **First visit.** Open `https://YOUR-SITE.netlify.app/tracker.html`, enter your `SETUP_CODE`, and create the admin account. Then Settings: staff, shop details,
   Slack (Send test), Email receipts (Send test email), IMEI check (Test connection, Load services, choose one).
5. **iPads:** open `https://YOUR-SITE.netlify.app/` in Safari > Share > Add to Home Screen.
   (Optional: Netlify can give the site your own address under Domain management.)

## How it saves data (so you know what to expect)
- Jobs, purchases, sales, staff and settings are saved together as one record in Netlify Blobs. If two people save at the same instant, the app notices, re-reads
  and saves again, so nothing is lost or double-numbered (tested with four servers saving at once).
- Seller ID photos are stored separately. Daily backups (last 30) are kept by the 10-minute job; you can also download one in Settings.
- A request must finish quickly on Netlify, so an IMEI check waits about 6 seconds and the page then keeps asking for the answer.
- Emails and Slack posts are sent straight after each save. If sending fails they are retried every 10 minutes (emails for up to 24 hours).
- The daily Slack summary is sent by the 10-minute job, so it can arrive up to 10 minutes after the time you set.
- Signing in lasts up to 2 hours (the admin panel logs out after 5 idle minutes). Removing a person or resetting their password signs them out everywhere.

## Cost
Netlify bills functions and storage on its credit system, and every open admin screen checks for changes every 30 seconds. A small shop should stay small,
but check your plan's limits and usage on Netlify.

## Run on your own server instead
`node server.js` (Node 18+, no installs) keeps everything in the `data` folder (set `DATA_DIR`, and `TRUST_PROXY=1` behind a proxy); the Dockerfile is included.
It uses the same settings names as above.
