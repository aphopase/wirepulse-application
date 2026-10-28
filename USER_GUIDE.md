# WirePulse User Guide

WirePulse lets you talk to a device over a USB/serial cable **from your web browser**. You can watch what the device prints, send it commands, chart the numbers it reports, and run automatic pass/fail checks on it. Nothing needs to be installed on your computer.

Your device's data stays on your computer. WirePulse never uploads what your device sends unless you export it yourself.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Quick start: your first connection in 2 minutes](#2-quick-start-your-first-connection-in-2-minutes)
3. [A tour of the screen](#3-a-tour-of-the-screen)
4. [Everyday tasks](#4-everyday-tasks)
5. [Hardware validation: automatic pass/fail tests](#5-hardware-validation-automatic-passfail-tests)
6. [Working with a team (optional Enterprise workspace)](#6-working-with-a-team-optional-enterprise-workspace)
7. [Troubleshooting](#7-troubleshooting)
8. [Keyboard shortcuts](#8-keyboard-shortcuts)
9. [Glossary](#9-glossary)

---

## 1. Before you start

| You need | Details |
|---|---|
| **Chrome or Edge** | Other browsers (Firefox, Safari) cannot talk to serial devices. Use a normal browser tab, not an embedded preview. |
| **A secure page address** | The address must start with `https://`, or be `localhost`. If you open WirePulse through a plain `http://` address or a bare IP number, the browser blocks serial access and WirePulse shows a red "Serial connection unavailable" box. |
| **A data USB cable** | Some cables only charge and carry no data. If your device never shows up in the list, try another cable. |
| **The device powered on** | And not already open in another program (Arduino IDE, PuTTY, a terminal). Only one program can use a serial port at a time. |
| **The right serial settings** | Speed (baud rate) and so on. They are in the device's documentation. The default, 115200 8-N-1, is the most common. |

On Linux you may also need permission to use serial ports (often by belonging to the `dialout` group). Ask your IT contact if the device is plugged in but never appears.

---

## 2. Quick start: your first connection in 2 minutes

1. **Open WirePulse** in Chrome or Edge, at the address your team gave you (if you are running it yourself: `npm install`, then `npm run dev`, then open the address it prints).
2. **Plug in your device.**
3. In the left panel, under **Connection**, check **Baud rate**. The default is `115200`. Change it if your device uses a different speed.
4. Click **Connect device**. The browser opens a small window listing available ports. Choose your device and click **Connect**.
5. The status at the top changes from **OFFLINE** to **CONNECTED**. Whatever the device prints now appears in the black log area.
6. **Type a command** in the box at the bottom of the log (for example `status`) and press **Enter**.

That is all you need to monitor a device. Everything else in this guide is optional.

> The first time, the browser asks you to pick the port. This is a browser safety rule: a website can never open a serial port on its own. After that the browser remembers the device you allowed, and on your next visit the button reads **Reconnect saved device**.

---

## 3. A tour of the screen

**Top bar**

- **Theme** menu: Obsidian, Nord, Amber or Phosphor (colour schemes). Your choice is remembered.
- **Docs ↗**: opens the web documentation for the browser's serial feature (not a WirePulse manual; this guide is).
- **Settings saved locally**: reminds you that your settings live in this browser only.

**Counters row**: RX bytes (received), TX bytes (sent), lines, warnings, errors, and the **CONNECTED / OFFLINE** light.

**Left panel (settings)**

| Section | What it is for |
|---|---|
| **Connection** | Connect/disconnect, baud rate and other serial settings, display format, line ending |
| **Binary frame decoder** | Picks out packets that start and end with bytes you choose (for binary protocols) |
| **Enterprise workspace** | *Optional.* Connect to your organization's shared server (see [section 6](#6-working-with-a-team-optional-enterprise-workspace)) |
| **Device profiles** | Save and reload a whole set-up with one click |
| **Quick macros** | Four buttons that each send a saved command |
| **GPS / NMEA** | Shows position and satellites if your device sends GPS sentences |

**Main area**

| Part | What it is for |
|---|---|
| **Toolbar** | Clear, Pause, Record session, Auto-scroll, export to TXT or CSV |
| **Search and filter bar** | Find text, show only received / sent / system lines, choose how many lines to keep |
| **Log** | Everything received (`‹`), sent (`›`) and notes from WirePulse itself (`·`), each with a time |
| **Command box** | Type a command and press **Enter** (or click **Send**) |
| **Hardware validation** | Automatic pass/fail tests ([section 5](#5-hardware-validation-automatic-passfail-tests)) |
| **Enterprise console** | Appears only after you connect a workspace |
| **Session recordings** | Save, load and replay a session |
| **Telemetry dashboard** | Live charts of numbers your device reports |

---

## 4. Everyday tasks

### 4.1 Connect and set the serial settings

Set these **before** you click **Connect device**. If you change one later, disconnect and connect again.

| Setting | What to choose |
|---|---|
| **Baud rate** | The speed your device uses. Common values: 9600, 115200. Choose **Auto detect** if you do not know it (see below). |
| **Data bits** | 8 in almost every case (7 is also offered). |
| **Stop bits** | 1 in almost every case (2 is also offered). |
| **Parity** | None in almost every case (Even and Odd are also offered). |
| **Flow control** | None, or **RTS/CTS** (hardware flow control) if your device needs it. |
| **Display format** | How incoming data is shown: **ASCII** (readable text), **Hexadecimal** (byte values) or **Binary**. |
| **Line ending** | What WirePulse adds to the end of everything **you send**: **LF**, **CR**, **CRLF** or **None**. Many devices only react once they see the right ending; if a command seems to be ignored, try another. |
| **Reconnect a known device** | When ticked, WirePulse reconnects by itself when the device you used before is plugged back in. If it is not ticked, or you prefer to do it yourself, click **Reconnect**. |

**Auto detect (baud rate).** If you choose *Auto detect*, WirePulse tries common speeds one after another. It can only recognise the right one if the device is already printing a known word, so type that word into **Expected word** (for example `READY`). **Listen per rate (ms)** is how long it listens at each speed (250 to 5000; the default is fine for most devices).

To finish, click **Disconnect** (or press **Ctrl+D**).

### 4.2 Send commands

- Type in the command box and press **Enter** or click **Send ↵**. The box is greyed out until you are connected.
- Your command is shown in the log with a `›`, and the device's answer follows with a `‹`.

### 4.3 Quick macros

Macros are four buttons for commands you use all the time. They start as **Status**, **Help**, **Version** and **Reset**.

1. Click **Edit** next to *Quick macros*.
2. Type a **label** (the name on the button) and the **command** it sends, for each of the four.
3. Click **Done**.

Click a button to send its command. The buttons are greyed out until you are connected.

> **Careful with Reset.** The built-in fourth macro sends the word `reset`. If your device understands that word, it will restart. Change it in the editor if you do not want that.

### 4.4 Read, search and filter the log

- **Search**: type in the search box (or press **Ctrl+F**). Matching text is highlighted, and lines that do not match are hidden.
- **Show only…**: choose *All messages*, *Received only*, *Transmitted only* or *System only*.
- **Keep**: how many lines WirePulse holds on screen (500 up to 10,000). Older lines drop off the top. The default is 2,000.
- **Auto-scroll**: keeps the newest line in view. Untick it to read in peace while data keeps arriving.
- **Colours**: received lines containing words like *error*, *fail*, *fatal*, *panic* or *exception* are marked as errors; *warn* or *warning* are marked as warnings. They are counted in the **errors** and **warnings** boxes at the top.
- **Clear** empties the log (**Ctrl+L**).

> **Pause throws away new data.** While you are paused, anything the device sends is **not shown, not recorded, and not seen by the tests, charts or the error/warning counters**. It is not saved up for later (only the RX bytes counter keeps counting). Untick **Auto-scroll** if you only want the view to stop moving. Do not pause while tests run.

### 4.5 Save the log to a file

- **↓ TXT** (or **Ctrl+S**): a plain text file with a time, direction and text on each line.
- **↓ CSV**: a spreadsheet-friendly file with the columns `timestamp, direction, text`.

Both contain everything currently in the log (up to the **Keep** limit), regardless of the search or filter you are using.

### 4.6 Telemetry: chart the numbers your device reports

WirePulse does not measure anything itself. It draws charts from numbers **your device prints**.

For a number to be picked up, the device must print a line with a **name**, a `:` or `=`, and the **value**, for example:

```
TEMP0: 24.5
TEMP1=3.30
```

There are ten channels. They are named `TEMP0` to `TEMP9` to begin with.

1. In **Telemetry dashboard**, click **Configure**.
2. For each channel you want to use, set:
   - **On**: tick it to watch this channel.
   - **Token**: the name your device prints, such as `VBAT`. (It is not case-sensitive, and shown in capitals.)
   - **Name** and **Unit**: how the chart is labelled (for example "Battery", "V").
   - **Warn ≥** and **Critical ≥** (optional): raise an alert when a value reaches or passes these numbers.
3. Click **Done**.

A chart appears as soon as the first value arrives, showing the latest value and the minimum, maximum and average. If you set thresholds, a **Live alerts** list shows each time one was crossed, with a **Clear alerts** button. Up to ten charts can be active at once.

### 4.7 GPS / NMEA

Tick **Parse NMEA sentences** if your device sends standard GPS text (the lines starting `$GPRMC`, `$GPGGA` and similar). WirePulse then shows the **Latitude**, **Longitude** and number of **Satellites** in the left panel. A dash (—) means nothing has arrived yet.

### 4.8 Binary frame decoder

For devices that send binary packets with a marker at each end:

1. Tick **Decode framed packets**.
2. Enter the **Start byte** and **End byte** as two hex digits (the defaults are `AA` and `55`).
3. Optionally set **Checksum** to *XOR: last payload byte* to have each packet checked.

Each packet found appears in the log as a line starting with `FRAME`, followed by its bytes, and `XOR OK` or `XOR FAIL` if you chose a checksum. It is a viewing aid: it simply looks for your two marker bytes, so it only makes sense if your device frames its data that way. For a clearer view, set **Display format** to *Hexadecimal*.

### 4.9 Device profiles: save a whole set-up

A profile remembers the serial settings, the four macros and the telemetry set-up. Use one per device type.

- **Save**: type a name under *Device profiles* and click **Save** (or press Enter).
- **Load**: click the profile's name.
- **Delete**: click the **×** next to it.
- **Share with a colleague**: click **Export** to download all your profiles as a file. They click **Import profiles** and choose it.

Profiles are stored in your browser only. They are not sent anywhere unless you use *Share profile* in an Enterprise workspace (section 6).

### 4.10 Record a session and replay it

Useful for reproducing a problem or showing a colleague what happened.

1. Click **● Record session**. The button turns to **■ Stop recording** while it records.
2. Do what you need to do, then click **■ Stop recording**.
3. Click **Save recording** to download a `.json` file.
4. Later, click **Load recording** and pick that file, then click **Replay** to watch it back (and **Stop replay** to stop).
5. **Export raw bytes** saves the exact bytes received, as hex text, for tools that need them.

Starting a new recording discards the previous unsaved one. A recording holds at most the number of lines set in **Keep** (2,000 by default), so raise that number first for long sessions.

---

## 5. Hardware validation: automatic pass/fail tests

Instead of watching the log and judging by eye, you can write small tests: *"send `status`; the device must answer `READY`"*. WirePulse runs them in order and shows **PASS** or **FAIL** for each. Your tests are saved in your browser automatically.

### 5.1 Write a test

Under **Hardware validation**, click **+ Test**. Each test is one row:

| Column | What to enter |
|---|---|
| **Name** | A label for you, such as "Firmware ready". |
| **Commands (one per line)** | What to send. Put each command on its own line; they are sent in order. |
| **Expected text** | A word or phrase that must appear in the device's answer. It is not case-sensitive and may be part of a longer line. Leave empty to pass on *any* answer. |
| **Telemetry assertion** | *(Optional.)* A name, a comparison (**≥**, **≤** or **=**) and a number. Example: `VOLTAGE` `≥` `3.0` passes when the device answers with a line such as `VOLTAGE: 3.3`. |
| **Timeout / retries** | The first box is how long to wait for the answer, in milliseconds (default 2000). The second is how many extra attempts to make if it times out (0 to 10). |

The **×** at the end of a row deletes the test. A starter test, *Firmware ready* (`status` → `READY`), is already there.

### 5.2 Run the tests

1. **Connect** to the device first. (If you are not connected, WirePulse tells you so in the log.)
2. Click **Run all**. The button changes to **Stop run**, which you can click to abort.
3. Watch **Latest test run**. Each test shows **WAIT**, **PASS** or **FAIL**, plus the reason and the attempt number.

How a test is decided:

- WirePulse sends all of the test's commands, then **listens for the answer** for up to the timeout.
- Only text that arrives **after** the last command was sent counts. Leftover output from before is ignored (called *stale-response rejection*), so an old `READY` cannot make a test pass by accident.
- The test **passes** as soon as one answer line contains the expected text (and meets the telemetry condition, if you set one).
- If nothing suitable arrives in time, WirePulse tries again (up to the number of retries) and then marks the test **FAIL** with "Timed out after … ms".

### 5.3 Reports and evidence

- **Export CSV** downloads the results as a spreadsheet.
- Every run also builds a tamper-evident record: a chain of fingerprints (hashes) of what was sent and when answers were received. If anyone later changes a result, the chain no longer adds up.
- **Upload report** sends the pass/fail result of each test and the evidence record (fingerprints, byte counts and timings) to your team's Enterprise workspace. **The text your device sent is never uploaded.** You must be connected to a workspace to use it (section 6).

---

## 6. Working with a team (optional Enterprise workspace)

Everything above works on its own. If your organization runs a **WirePulse server**, you can also:

- share device profiles and test suites with colleagues,
- run tests on a **lab computer** that has the device attached, from your own desk,
- watch results arrive live, download them as JUnit files for CI, and keep a tamper-evident audit trail,
- give your CI system access, and manage who can do what.

Your administrator sets the server up (see [DEPLOYMENT.md](DEPLOYMENT.md)). This section is for people using it.

### 6.1 Connect

You need two things from your administrator: the **address (URL) of the server**, and a way to get an **access token** (a long temporary password issued when you sign in through your company login).

1. In the left panel, find **Enterprise workspace**.
2. Enter the **Control-plane URL**, for example `https://api.wirepulse.example.com`.
3. Paste your **OIDC access token**.
4. Click **Connect workspace**.

When it works, you see "Connected" and a list of your workspaces appears. The token is kept in memory only; it is **not saved**, so you paste a fresh one each time you reload the page. Tokens expire quickly by design; if you see "invalid token" messages, get a new one.

### 6.2 Workspaces and what you can do

A **workspace** is your team's shared space. Choose it under **Active workspace**; it shows your role next to the name. You can create your own with **New workspace name** and **Create**, and you become its administrator.

Your **role** decides what you may do:

| Role | Can do |
|---|---|
| **Viewer** | See jobs (live), gateways and usage; download results as JUnit; read shared profiles and test suites. |
| **Engineer** | Everything a viewer can, plus queue and cancel jobs, share profiles and tests, upload reports. |
| **Maintainer** | Everything an engineer can, plus register, edit, rotate and revoke gateways, and see the team list. |
| **Administrator** | Everything, plus change roles, remove people, invite people, create API keys, manage webhooks, and delete the workspace. |

Buttons you are not allowed to use are hidden. If you try something your role does not allow, you see *insufficient_workspace_role*; ask a workspace administrator.

### 6.3 Share and run

Once a workspace is selected:

- **Share profile** copies your current serial settings, macros and telemetry set-up to the workspace (named after the profile name box, or "Untitled device profile").
- **Share tests** copies your current hardware validation tests.
- **Queue gateway job** asks a lab computer (a **gateway**) to run your current tests. You can close your laptop; the lab computer does the work and the result appears in the Jobs list.
- **Upload report** (in *Hardware validation*) sends a result you ran yourself (see section 5.3).

### 6.4 Invitations

If an administrator invites you, an **Invitation** appears in the left panel after you connect, showing the workspace and role. Click **Accept**. You must sign in with the same email address they invited.

### 6.5 The Enterprise console

After you connect, the **Enterprise console** appears among the main panels. Its tabs:

**Jobs** (everyone): Each queued test run, newest first.

- The state is shown as a badge: *queued*, *assigned*, *running*, *passed*, *failed*, *stopped*, *cancelled* or *timed out*.
- A progress bar shows "x of y tests" while it runs. The line at the top says **Live** when updates arrive instantly; otherwise it refreshes every 10 seconds.
- **Cancel** stops a job that has not finished (engineer and above).
- **JUnit XML** downloads results for CI tools once a job has finished.
- **Details** shows who requested it, when, which gateway ran it, and the fingerprints of the evidence.
- A job that waited too long shows "No gateway picked the job up in time"; one whose lab computer vanished shows "The gateway stopped responding while running this job."

**Gateways** (everyone sees them; maintainers manage them): A gateway is a small program on the lab computer that has the device plugged in. It collects jobs from the server and drives the serial port; **device bytes never leave that computer.**

- A gateway shows **online**, **offline** or **revoked**, its last heartbeat, and (when online) the serial ports it can see.
- **Register a gateway** (maintainer): enter a **Name** (such as "Bench 3 PC"), optional **Labels** like `bench=3, board=esp32`, and an optional **Token lifetime** in days. Then click **Register gateway**.
- A one-time **token** appears. **Copy it now**: it is shown only once. Save it on the lab computer as the gateway's token file, and start the gateway program there ([DEPLOYMENT.md](DEPLOYMENT.md) has the exact steps for your administrator).
- **Edit labels**, **Rotate token** (issues a new token; the old one stops working at once, so update the lab computer), and **Revoke** (permanently disables the gateway).

**Team** (maintainers and administrators): Lists members and their roles. Administrators can change a role from the drop-down, **Remove** a member, and **Invite** someone: enter their **Email**, choose a **Role** and click **Invite**. The server emails them if email is set up; otherwise tell them yourself. Pending invitations can be revoked.

**API keys** (administrators): For automated systems such as CI that must start or read jobs without a person signing in. Give the key a **Name**, a **Role** (viewer, engineer or maintainer at most) and a **Lifetime** in days, then **Create key**. The key is shown **once**: put it straight into your CI secret store. Keys can be **Revoked** at any time, and the list shows when each was last used.

**Webhooks** (administrators): Make the server call your own system when a job finishes. Add a **Name** and the receiving **URL**. A one-time **secret** is shown; your receiver uses it to check each message's `X-WirePulse-Signature`. Use **Send test** to try it, **Deliveries** to see what was sent (and **Redeliver** if one failed), **Rotate secret**, **Disable/Enable**, **Edit** or **Delete**. If you see "Webhooks are not enabled on this server", the operator has not turned them on.

**Usage** (everyone): Your plan, and how much of each allowance you have used this month (members, gateways, API keys, webhooks, queued jobs, jobs and reports per month). Monthly counters reset on the 1st (UTC). If you hit a limit you see "the … plan limit for … is reached"; free something up or ask your provider for a bigger plan. Administrators also find **Delete this workspace** here. It stops all access immediately and requires typing the workspace name to confirm; your provider can restore it within the grace period.

> **One-time secrets.** Gateway tokens, API keys and webhook secrets are displayed exactly once, in a box with **Copy** and **I have saved it — hide** buttons. If you lose one, you cannot view it again: rotate it (gateways, webhooks) or revoke it and create a new one (API keys).

### 6.6 Set-up checklist for a new team

For whoever is setting up a workspace first:

1. **Administrator:** connect, click **Create** to make the workspace.
2. **Administrator:** invite colleagues in **Team**, choosing the lowest role that does their job.
3. **Maintainer:** on each lab computer, register a gateway (**Gateways**), save its token, start the gateway program.
4. **Anyone with a device:** write tests (section 5), click **Share tests**, then **Queue gateway job**.
5. **Everyone:** follow progress in **Jobs**; download JUnit if CI needs it.
6. **Administrator (optional):** create an **API key** for CI and a **webhook** to be told when jobs finish.

---

## 7. Troubleshooting

### Connecting

| What you see | Likely cause and fix |
|---|---|
| Red box: *Serial connection unavailable. … not secure* | You opened WirePulse over plain `http://` or an IP address. Use `https://` or `localhost`. |
| Red box: *Web Serial is not exposed in this browser…* | Wrong browser or an embedded preview. Use current Chrome or Edge in a normal tab. |
| The port list is empty | Try a different USB cable (it must carry data), another USB port, and check that the device is powered. On Linux check serial-port permissions. |
| The connect step fails or says the port is busy | Another program is using it. Close the Arduino IDE, PuTTY, other terminals and other browser tabs, then try again. |
| Connected, but the screen is empty | Check the baud rate. Some devices print only when you send them something: try a macro or press Enter. |
| Garbled characters | Wrong baud rate or data/stop/parity setting. Try **Auto detect** or check the device's manual. |
| A command seems ignored | Wrong **Line ending**. Try CR or CRLF instead of LF. |
| Nothing new appears | You may have paused. Click **Resume**. |
| The button says **Reconnect saved device** but I want a different device | WirePulse reuses the last device you allowed. To pick another, remove the serial-port permission for this page in the browser's site settings (the icon beside the address), then reload. |
| The log says *Serial device disconnected.* | The cable came out or the device lost power. Plug it back in; it reconnects by itself if **Reconnect a known device** is ticked, otherwise click **Reconnect**. |

### Tests

| What you see | Likely cause and fix |
|---|---|
| *Connect a device before running tests.* | Connect first. |
| FAIL: *Timed out after … ms* | The expected answer did not arrive in time. Check the **Expected text** spelling; raise the timeout; check **Line ending**; add a retry. Make sure you did not pause. |
| FAIL: *No active serial connection.* | The device was unplugged or disconnected mid-run. Reconnect and run again. |
| Telemetry assertion never passes | The device's line must look like `NAME: value` or `NAME=value` with a plain number, and the name must match the **Token** (case does not matter). |
| *Run the validation suite again to create a privacy-preserving evidence report before upload.* | Click **Run all** again, then **Upload report**. |

### Telemetry

| What you see | Likely cause and fix |
|---|---|
| "No telemetry channels yet" | The device has not printed a matching line yet. Check the token name and that the channel is ticked **On**. The name must start the line or follow a space. |

### Enterprise workspace

| What you see | Likely cause and fix |
|---|---|
| *Enter the HTTPS control-plane URL and your OIDC access token.* | One of the two boxes is empty. |
| *Enterprise connection failed: network error* | The server could not be reached from this page. Check the URL and your network; if it still fails, ask your administrator, because the server must be set up to accept requests from the page you are using. |
| *Enterprise connection failed: invalid_bearer_token* (or similar) | Your access token has expired or is wrong. Get a new one and paste it again. |
| *insufficient_workspace_role* | Your role does not allow that action. Ask an administrator for a higher role. |
| *Live updates refused for this credential — refreshing every 10 s* | Jobs still update, just a little slower. |
| A job stays **queued** ("Waiting for a gateway to claim it") | No gateway is online. Open the **Gateways** tab; the lab computer's gateway must show **online**. |
| Gateway shows **offline** | The gateway program on the lab computer is stopped or cannot reach the server, or its token was rotated or expired. Restart it with the current token. |
| A gateway, key or webhook secret was lost | Rotate (gateway, webhook) or revoke and recreate (API key). They cannot be displayed again. |
| *plan limit … is reached* | Your workspace plan is full for that item. Remove something or ask your provider for a larger plan. |

---

## 8. Keyboard shortcuts

Use the **Control** key (also on a Mac, not Cmd).

| Keys | Action |
|---|---|
| **Ctrl+F** | Jump to the log search box |
| **Ctrl+L** | Clear the log |
| **Ctrl+S** | Download the log as TXT |
| **Ctrl+D** | Disconnect the device |
| **Enter** (in the command box) | Send the command |

The `M1`–`M4` labels on the macro buttons are just names; click the button to send.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **Serial / UART** | A simple way for a device to talk over a cable, one byte at a time. |
| **Baud rate** | The speed of that conversation. Both sides must use the same. |
| **RX / TX** | Received from / transmitted to the device. |
| **Line ending (LF, CR, CRLF)** | The invisible character(s) at the end of a line that tell the device "that is the whole command". |
| **ASCII / Hex / Binary** | Ways to show the same bytes: as text, as base-16 numbers, or as bits. |
| **Telemetry** | Measurements the device reports about itself, such as temperature or voltage. |
| **NMEA** | The standard text format GPS modules use. |
| **Macro** | A button that sends a saved command. |
| **Profile** | A saved set of serial settings, macros and telemetry set-up. |
| **Evidence (hash chain)** | A tamper-evident record of a test run. Each step includes a fingerprint of the one before it, so changes are detectable. |
| **Workspace** | Your team's shared space on the server. |
| **Gateway** | A small program on a lab computer that runs queued tests on the attached device. |
| **Job** | One queued test run. |
| **JUnit XML** | A standard results file that CI tools understand. |
| **API key** | A password for a program (such as CI) rather than a person. |
| **Webhook** | An automatic message the server sends to another system when something happens. |
| **OIDC access token** | A short-lived pass issued by your company login to prove who you are. |

---

## Privacy in one paragraph

WirePulse runs in your browser. Serial data goes between your device and your browser and nowhere else. Settings, macros, profiles and tests are kept in your browser's local storage. If you connect to an Enterprise workspace, only what you choose is sent to your organization's server: shared profiles and tests, queued jobs, and test **results with an evidence record** (fingerprints, byte counts and timings). Raw device output stays with you (or on the lab computer that holds the device) unless you export it. Your access token is held in memory only and is forgotten when you reload the page.

## More documents

| Document | For whom |
|---|---|
| [ENTERPRISE.md](ENTERPRISE.md) | What the enterprise features do, and what they do not do |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Administrators: installing and running the server and gateway |
| [README.md](README.md) | Developers: running and testing from source |
