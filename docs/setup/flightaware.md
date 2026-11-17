# Connect FlightAware (Flights widget)

The **Flights** widget tracks your flights by number: scheduled and expected times, delays, gates,
terminals, baggage claim and progress in the air. The data comes from **FlightAware AeroAPI** with
your own key. It works on Portly's own page, on the Pages site connected to Portly and on another PC.
It is not on the browser-only site, because the key stays in Portly's encrypted vault.

| What | How |
| --- | --- |
| Flights you type in | Flight number (`UA 123`, `BA117`, `B6 615`) and the local departure date, in the widget's settings |
| Flights in your calendar | Flight numbers in the titles or locations of events in the next 30 days, such as "Flight to Denver (UA 123)". On by default; switch it off in the widget's settings |
| A row | Route, status (on time, delayed, in the air, landed, cancelled), departure and arrival times in each airport's own time zone, terminal and gate, a progress bar in the air |
| Click a row | Opens the flight on flightaware.com |
| The × on a row | Stops tracking it. A calendar flight stays hidden; **Show again** in the settings brings hidden ones back |

A flight drops off 6 hours after it arrives (or is cancelled). FlightAware has a flight's details from
two days before it departs; until then the row says it is waiting.

## 1. Get an AeroAPI key

1. Sign in (or create a free FlightAware account) at <https://www.flightaware.com/aeroapi/portal/>.
2. Choose the **Personal** tier. It has no monthly fee and includes **$5 of free use a month**.
   FlightAware asks for a card for anything above that.
3. Optional but recommended: set a monthly spending limit in the portal.
4. Under **API Keys**, create a key and copy it.

## 2. Save it in Portly

1. Open **Settings → Accounts** and click the **FlightAware** tile.
2. Paste the key and click **Save key**. Portly checks it with FlightAware's free usage call before it
   stores it, encrypted, on this PC. The key is never shown again and never reaches the browser.
3. Add the **Flights** widget (**Edit layout → Add widget**) and add a flight in its settings.

To replace the key, use **Manage** on the FlightAware row. **Remove** deletes it from Portly; delete
it in the AeroAPI portal too if you no longer want it.

## What it costs

Each flight lookup costs **$0.005** (half a cent). Portly keeps every answer and shares it between
widgets, tabs and PCs, and asks again only as often as the flight needs:

| When | How often |
| --- | --- |
| More than 2 days before departure | never (FlightAware has nothing yet) |
| More than a day before departure | every 3 hours |
| 6 to 24 hours before | every hour |
| 1 to 6 hours before | every 15 minutes |
| The last hour, taxiing, after landing | every 5 minutes |
| In the air | every 10 minutes, every 5 in the last 45 minutes |
| Arrived or cancelled | not again |

A typical flight tracked from two days out costs about 80 lookups, around **$0.40**, so the free $5
covers about a dozen flights a month. Answers live in memory only, so restarting Portly asks again.

## Problems

| You see | Do this |
| --- | --- |
| "Connect FlightAware" | Save a key (step 2). |
| "FlightAware key refused" | The key was deleted or mistyped in the portal. Paste a new one under **Manage**. |
| "FlightAware has no such flight on this date" | Check the flight number and the **local** departure date. Codeshare numbers sometimes aren't known; use the operating airline's number. |
| "FlightAware is limiting requests" | The Personal tier allows 10 lookups a minute. Portly waits as long as FlightAware asks and tries again. |
| A calendar event's flight isn't found | The title or location needs the airline code and number together ("UA 123", "DL1234"), or the word "flight" next to a less common code. |

**Settings → Diagnostics** shows the FlightAware connection under **Flights**. Logs never contain the
key or your flight numbers.
