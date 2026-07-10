# SafeWeb — Consent, Transparency & Acceptable Use

SafeWeb is **accountability and parental-control software**. It is designed to
help people who *want* help staying away from adult content, and to let parents
protect minor children. Its design deliberately makes monitoring **visible** —
that is the single most important thing separating legitimate accountability
software from spyware / stalkerware.

## The consent principle

The person whose device is protected must **know** they are being monitored and,
where they are an adult, must **agree** to it. SafeWeb enforces this in code, not
just in policy:

- **Enrollment requires acknowledgement.** A device cannot be paired without an
  explicit consent acknowledgement (`consentAck`). The server rejects enrollment
  without it.
- **A persistent on-device indicator** ("Protected by SafeWeb") is always shown
  in the browser so the user is never unaware that monitoring is active.
- **The popup always names the accountability partner** who receives reports, so
  the protected person knows exactly who can see the activity.
- **Turning protection off is permitted** — but doing so notifies the partner.
  SafeWeb never tries to trap a user or hide its own removal.

## What SafeWeb deliberately does NOT do

- No hidden/stealth mode. No disguising the app as something else.
- No keystroke logging, no screenshots, no microphone/camera access.
- No shipping of full page contents or a complete browsing history. Only
  categorized events (a blocked site, a trigger-word category hit) and short
  **redacted** snippets are sent to the partner.
- No location tracking.

## Appropriate use

- **Self-accountability:** you install it on your own device and choose a trusted
  accountability partner.
- **Parental controls:** a parent protects a **minor child's** device. Age-
  appropriate transparency still applies — the child should be told.

## Inappropriate use (do not do this)

Installing SafeWeb on another **adult's** device without their knowledge or
consent to surveil them is abuse, is very likely **illegal** (wiretapping /
stalking statutes in many jurisdictions), and is exactly what SafeWeb's visible
indicators are designed to prevent. The reports go to the accountability partner
because the monitored person **chose** that partner — not so that someone can spy
on a partner or another adult covertly.

If you are being monitored without your consent, or are in an unsafe
relationship, resources like the National Domestic Violence Hotline
(1-800-799-7233, thehotline.org) and the Coalition Against Stalkerware
(stopstalkerware.org) can help.

## Data handling

- Activity data belongs to the household/individual and stays on the server you
  run. SafeWeb ships with a self-hostable server; there is no third-party data
  broker in the loop.
- Redaction happens **on-device** before any snippet leaves the machine.
- Partners and devices authenticate with hashed credentials; secrets are never
  stored in plaintext.
