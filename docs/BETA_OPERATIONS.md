# Controlled beta operations

This runbook accompanies `BETA_READINESS.md`. It describes controls available in
the repository; it does not replace provider billing alerts, live acceptance or
an assigned human on-call owner.

## Cohort control

Keep registration open for direct messaging, and distribute the beta URL to the
small group of people who have agreed to test it. This distribution boundary is
the trust control for this limited beta; the signup page itself is not an
invite-only allowlist. Set `BETA_MAX_ACTIVE_ACCOUNTS` to the agreed cohort
ceiling (default 250). The server serializes final signup admission and refuses
new registrations once the number of non-deleted accounts reaches the cap. Set
`BETA_SIGNUPS_ENABLED=false` to pause new accounts immediately. Neither control
removes existing accounts or blocks them from using the service.

Before sharing the URL, nominate a moderator and support contact, then run
`cd backend && node scripts/provision-moderator.js grant <email>` and verify
the account's `/moderation/reports` access. Revoke access with the same command
and `revoke`. Provisioning records role changes in the
append-only moderation audit. Keep credentials and the beta URL out of public
directories; if the signup link is broadly published, treat the cohort as
untrusted and revisit malware scanning before continuing.

## Storage and spend watch

Configure these backend values for the beta environment:

- `BETA_STORAGE_ALERT_GB`: storage level that requires an operator review.
- `BETA_STORAGE_USD_PER_GB_MONTH`: the storage-only price estimate per GiB-month
  in USD, using the provider's current rate and the billing region. Zero means
  no estimate is configured.
- `BETA_STORAGE_MONTHLY_BUDGET_USD`: storage-only estimate threshold. Zero
  disables that threshold.

The moderator inbox shows current active upload bytes, provider split, unclaimed
uploads, top accounts and teams, deletion queue health, and the configured
storage-only estimate. For a scheduled report, run
`cd backend && npm run storage:report`. Exit status 2 means a configured storage
threshold/budget or repeated deletion failure needs review; status 1 means the
report itself failed. Schedule it daily in the deployment's existing operator
job system and retain timestamped output with the release evidence.

This estimate does not include data transfer, class A/B requests, multipart
operations, previews, taxes, credits, minimums, or unrelated account usage. It
is not a provider billing API or a real-time spend alarm. An operator must also
review the R2/provider billing dashboard at least daily during the beta and set
the provider's own spend alert where available. Set the environment threshold
below the planned beta budget so the estimate provides room to react.

When a threshold fires, or actual provider spend reaches 75% of the agreed
monthly budget, the operator should review top users/teams and unclaimed uploads,
inspect repeated cleanup failures, pause signup if growth is unexpected, and
remove abusive or abandoned content through the supported application workflow.
At 90% of budget, pause new uploads or the beta until a budget owner decides
whether to increase the cap. Record the observation, decision, operator and
follow-up in `RELEASE_EVIDENCE.md`. These response percentages are beta operating
thresholds, not provider-enforced billing limits.

Storage quotas remain deferred for this cohort. This is acceptable only while
the account cap, daily storage report, provider billing review and response
owner are active. If the report cannot be run or a provider billing owner is
unavailable, pause signup and upload acceptance until monitoring is restored.

## Malware scanning and takedown

Malware scanning is not implemented. Deferral is conditional on a small,
personally known beta cohort and controlled distribution of the signup URL; the
numeric account cap alone does not make unknown registrants trusted. Current
controls include server-side MIME allowlisting and magic-byte checks, per-type
size limits, authenticated attachment serving, `Content-Disposition: attachment`
and `X-Content-Type-Options: nosniff`. These controls reduce exposure but do not
prove that a file is safe.

For a suspected malicious or abusive attachment:

1. A moderator records the report and relevant room/account in the report inbox.
2. Review only the bounded room context provided, record a reasoned status
   transition, and suspend the account when continued access presents a risk.
   Suspension revokes active sessions. Do not download or redistribute a
   suspicious payload to investigate it.
3. A room admin or the message author can use the existing message deletion
   workflow for confirmed content removal, then inspect the cleanup queue until
   provider deletion succeeds. The moderator inbox does not currently provide
   platform-wide message removal. If the room admin/author cannot act promptly,
   escalate to the beta operator for an approved storage-level containment
   action; do not claim removal until the message is inaccessible and the
   object cleanup is confirmed.
4. Notify the affected reporter through the established support channel without
   exposing another user's private data. Record the evidence, actions, times,
   cleanup result and any restoration decision in the incident record.
5. Escalate suspected account compromise, exposure outside the intended room,
   or a cleanup failure to the beta operator and storage provider. Pause uploads
   or signups if containment cannot be confirmed.

Platform-wide moderator content removal is not yet implemented. Before a beta
that cannot rely on a responsive room admin/author and an available storage
operator, add a dedicated audited takedown action. Do not broaden distribution or begin a public launch while malware scanning is
deferred. Any public signup promotion, repeated malicious upload, or inability
to complete takedown is a stop condition: pause the beta and add quarantine plus
trusted malware scanning before reopening.

## Moderator actions

Use the report inbox for report review, status transitions and account
suspension/restoration. Every report view, transition and suspension action is
recorded. Restoration enables a fresh login; revoked sessions are not revived.
The first beta moderator is provisioned out of band by an operator with database
access. Never expose role grants as a public API. Treat moderation context as
sensitive, and review only what is needed to resolve the report.
