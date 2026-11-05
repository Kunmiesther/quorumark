# Turtle Bot — App Review notes

Replace every bracketed value before submission.

## Reviewer access

- Demo account: `[REVIEW_EMAIL]`
- Password: `[REVIEW_PASSWORD]`
- Demo mode is enabled by default and never places a real order.
- Contact: `[REVIEW_CONTACT_NAME_AND_PHONE]`

## What Turtle Bot is

Turtle Bot is noncustodial trading-control software. Customer funds remain at a
customer-selected exchange or wallet. Turtle Bot cannot withdraw, transfer, or
take custody of customer assets. Exchange credentials are accepted only when
withdrawal permission is disabled. The product begins in simulated Paper mode.

## Trading and jurisdiction controls

- Live ApeX execution is disabled in the shipped application pending documented
  jurisdiction and licensing approval.
- Customer-facing centralized exchange choices are Coinbase and Kraken.
- Before enabling a venue for live execution, attach the venue authorization,
  supported-country list, and legal review to the App Review submission.
- Derivatives and other restricted products must remain unavailable in every
  territory where the required permission has not been documented.

This file is an engineering checklist, not legal advice. Onixus must obtain
qualified counsel's approval for each live venue and storefront territory.

## Security model

- Withdrawal credentials, wallet private keys, seed phrases, and PINs are never
  requested.
- Deterministic limits size and gate every trade; AI cannot bypass them.
- Onyx is advisory unless the user separately enables a validated automation.
- AI-provider keys are encrypted and never returned to the client.

## AI disclosure

Profile → AI & privacy contains a separate, revocable opt-in. Without that
permission, Onyx uses the guided rules engine and does not send account context
to a third-party AI provider. Secrets are excluded in either mode.

## Account deletion

Profile → Delete account opens a confirmation dialog. Entering `DELETE` calls
the authenticated `delete-account` Edge Function, permanently deletes the
caller's Auth account and cascading application data, and signs out locally.
The public fallback instructions remain available at `/data-deletion`.

## Network behavior

The native container loads `https://www.turtlebot.app` because live prices,
account state, Onyx, and order controls require the service. If it is unreachable,
Capacitor displays the bundled offline screen with an explicit retry action.

## Non-obvious review path

1. Sign in with the reviewer account.
2. Complete onboarding in Paper mode.
3. Open Ask Onyx on Home; no route change occurs.
4. Review Trade in Paper mode and confirm that no live funds are involved.
5. Open Automation and inspect risk boundaries and Council settings.
6. Open Trust Center to see connection permissions and the emergency stop.
7. Open Profile to inspect AI permission and account deletion.
