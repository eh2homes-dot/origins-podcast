# Origins podcast site

The website for **Origins: How Leaders Got Their Start**.

- `src/worker.js` builds every page and handles the two forms. Episodes come from the beehiiv podcast feed, so publishing an episode in beehiiv creates its page here (within about 10 minutes).
- `public/` holds the styles, the cover art, and the optional per-episode extras.
- `wrangler.jsonc` holds the settings: links, the feed address, and the launch switch.
- There is no build step. Every push to `main` republishes the site once the repo is connected in Cloudflare.

## Adding the extras for an episode

The feed gives each episode its title, description, date, audio and runtime. Everything else is optional and lives in one file per episode:

`public/data/episodes/<episode number>.json` (for episode 1: `public/data/episodes/1.json`)

Copy `public/data/episodes/example.json`, rename it, and fill in what you have. Leave out anything you don't have and that section simply doesn't show.

| Key | What it adds |
| --- | --- |
| `youtubeId` | The video at the top of the page. It is the part after `v=` in the YouTube link. Without it the page shows an audio player. |
| `tags` | Topic tags under the title. |
| `guest` | Name, title, company, LinkedIn, and a photo (put the image in `public/assets/guests/`). |
| `chapters` | Timestamps that jump to that point in the video. |
| `notes` | Bullet points under the show notes. |
| `transcript` | The collapsible full transcript. |
| `roles` | The roles from that week's jobs roundup. |

## Settings (`wrangler.jsonc`)

- `SITE_LIVE`: `"false"` until launch day. While false, search engines are told not to list the site. Set to `"true"` to launch.
- `SPOTIFY_URL`, `APPLE_URL`: empty until the show is approved. The buttons appear once these are filled in.
- `AIRTABLE_BASE_ID`: the Podcast base that receives form submissions.

## Forms

"Be a guest" and "Sponsor" save a row to the Podcast base in Airtable (tables `Guest nominations` and `Sponsor inquiries`). An Airtable automation on each table sends the notification email.

The Airtable access token is a secret and is **not** in this repo. Add it in Cloudflare: Worker → Settings → Variables and Secrets → add a secret named `AIRTABLE_TOKEN`. Until it is set, the forms tell people to email instead.
