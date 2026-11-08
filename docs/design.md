# Design direction

Tokens (colors, fonts, radius) live in the app's global CSS: tweakcn "vercel" theme, Geist font, with `--destructive` in light mode set to `oklch(0.56 0.19 23.03)` to pass 4.5:1. An accent color, if any, is added as a token there and must reach 4.5:1 as text on `--background`. This file is the direction.

## Overview
A CRM for Brambilla Forniture's sales reps, an industrial-supplies distributor in Northern Italy,
replacing a 15-year-old on-premise system. Tone: precise, calm, dense. UI text in English, data in
Italian as written. Never the HubSpot name or logo. The memorable element: every imported record
shows its Sinergia legacy ID, so the migration can be checked against its source.

## Layout
- Left nav: Companies, Contacts, Deals, Tickets, Dormant customers. The assistant is a chat
  panel available from every page.
- Lists: search, filters, pagination with exact totals, tabular numbers right-aligned.
- Company page (jury): header with name, domain, city, `partita_iva`, then 2025 revenue and class
  as the dominant figures; below, contacts, deals and the activity history.
- Deals board (jury): one column per stage, pipeline switch Vendite / Rinnovi, card shows title,
  company, amount with currency, owner.
- Dormant customers (jury) and tickets (jury): dense tables, status and priority as text badges.

## Components
- Compose from the shadcn components installed in `crm/web`; add missing ones with the shadcn CLI.
- Assistant panel: the user's message, then what the assistant did (records read or changed) and its reply. Changes are shown as links to the records.
- Every async view has: loading with specific text ("Comparing Q2 and Q3 invoices", not "Processing..."), empty (invites an action), error (what happened, how to fix, Retry).

## Don't
Purple/blue gradients, gradient text, glow, glassmorphism, emoji as icons, badge above the headline, three icon cards in a row, colored side borders, nested cards, fade-in on scroll, cursor effects, buzzword copy, all-caps eyebrows.

## Do
Sentence case. Real domain data. Buttons say what happens ("Run analysis", not "Submit"). Motion only on state change, respect prefers-reduced-motion. Visible focus rings. AA contrast.
