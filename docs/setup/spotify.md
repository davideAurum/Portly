# Connect Spotify

The **Music** widget shows what is playing on your Spotify account and lets you control it from
your home page:

| What | How |
| --- | --- |
| See what is playing | Cover art, title, artists, how far along it is, and which device it is on |
| Control it | Play, pause, skip, seek, volume, shuffle and repeat |
| Choose the device | Move playback to your PC, phone or a speaker, or start it on one when nothing is playing |

The widget is a remote control. **The music plays in Spotify, on your own devices, not in the
Portly tab**, so it keeps going while that tab goes somewhere else. Spotify has to be open on at
least one device for the widget to have something to control. The Spotify desktop app, the mobile
app and the web player at <https://open.spotify.com> all count.

## What you need

- **Spotify Premium.** Spotify only lets an app work if the account that created it has Premium,
  and only Premium accounts can control playback. Without it there is no widget, not even a
  read-only one.
- **About 5 minutes**, once, to create your own Spotify app.

Portly has no central server, so the Spotify app is yours and is used only by you.

## Where it runs

The widget works the same in both places. What differs is who talks to Spotify and where your
sign-in is kept.

| | Portly on your PC, or a browser paired or connected to it | The browser-only site |
| --- | --- | --- |
| **Who talks to Spotify** | The Portly server | The browser itself |
| **Your sign-in** | Encrypted on your PC, and never reaches the browser | In that browser, not encrypted ([what that means](static-build.md#where-your-data-lives)) |
| **Signing in** | Once, for every browser using that Portly | Once per browser |
| **Redirect URI** | `http://127.0.0.1:5757/api/oauth/spotify/callback` | The site's own address, like `https://<user>.github.io/` |

One Spotify app can do both: list both redirect URIs in it and use the same Client ID. Portly always
shows you the one for the place you are in.

## 1. Create your Spotify app

1. In Portly, open **Settings → Accounts** and click the **Spotify** tile. The dialog shows the
   **redirect URI** you need in a moment. Leave it open.
2. In another tab, open the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and sign in with your **Premium** account. Accept the developer terms if asked.
3. Click **Create app** and fill in:
   - **App name:** anything of yours. Spotify does not allow the word "Spotify" in it.
   - **App description:** for example "My home page".
   - **Redirect URIs:** paste the one from Portly and click **Add**. It must match exactly. With
     Portly on your PC it starts with `127.0.0.1` on purpose: Spotify refuses `localhost`.
   - **Which API/SDKs are you planning to use?:** tick **Web API**.
4. Accept the terms and click **Save**.
5. Open the app's **Settings** and copy the **Client ID**. You do not need the client secret: Portly
   proves who it is another way (PKCE).

## 2. Connect it to Portly

1. Back in Portly, paste the **Client ID** and click **Save and continue**.
2. Keep **Music** ticked and continue, then click **Sign in with Spotify**.
3. Spotify asks you to allow Portly to read what is playing and control it. Accept, and you land
   back on Settings → Accounts.

## 3. Add the widget

Click the edit (pencil) button on the home page, then **Add widget → Music**. Drag a corner to make
it larger: more room brings the seek bar, volume and bigger cover art.

## What Portly can reach

Portly asks for two permissions only:

| Permission | Why |
| --- | --- |
| `user-read-playback-state` | What is playing, and on which device |
| `user-modify-playback-state` | Play, pause, skip, seek, volume, shuffle, repeat, and moving playback between devices |

It cannot see your playlists, your library or your listening history, and it changes nothing in
them. What is playing is kept in memory for a few seconds, so several widgets (and, with Portly on
your PC, several tabs) can share one answer. It is not written to disk or to the logs. Cover art
loads directly from Spotify's image server (`i.scdn.co`), so that server sees your IP address, as it
does when you use Spotify itself.

## Good to know

- **Reconnecting.** Spotify's sign-ins last six months, whatever you do. When yours runs out, the
  widget and Settings → Accounts offer **Reconnect**: one click, about twice a year.
- **Other people.** A Spotify app works for up to five accounts. To let someone else use yours, add
  them under **User Management** in the dashboard. They need to be listed before they sign in.
- **If your Premium ends**, Spotify stops the app until it is back. Nothing needs setting up again.
- **Some devices refuse some controls.** Cast devices, for instance, may not take volume or seek.
  The widget greys out what Spotify says is not available, and hides what the device cannot do.
- **Disconnecting.** Settings → Accounts → **Remove** deletes the sign-in from Portly. To withdraw
  the permission at Spotify too, use your account's
  [Manage apps](https://www.spotify.com/account/apps/) page.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Spotify shows **INVALID_CLIENT: Insecure redirect URI** or **Invalid redirect URI** | The redirect URI in the dashboard does not match. Copy it again from Portly's dialog, exactly as shown. On the browser-only site, that is the site's own address, next to the `127.0.0.1` one if you have both. |
| **The service refused this account** after signing in, or **Spotify refused access** in the widget | The account that created the Spotify app has no Premium, or the account you signed in with is not on the app's **User Management** list. |
| **Spotify only lets Premium accounts control playback** | The account you connected has no Premium. |
| **Nothing is playing**, with no devices listed | Open Spotify on a device and start or pause anything once. Devices drop off after a while without use. |
| **Spotify is rate limiting requests** | Wait a moment. Portly stops asking until Spotify's wait is over, then carries on. |
| The widget says **Reconnect** | Your six months are up, or access was withdrawn. Click **Reconnect**. |

More in [Troubleshooting](troubleshooting.md).
