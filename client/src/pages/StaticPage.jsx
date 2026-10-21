import { Link } from "react-router-dom";
import Logo from "@/components/landing/Logo";

const CONTENT = {
  Pricing: {
    intro:
      "Conclave does not currently offer self-serve paid plans or in-product billing.",
    sections: [
      [
        "Current availability",
        "This release is an early collaboration product. Workspace access is managed by the people who invite you. No price, storage tier, service-level commitment, or paid feature is being offered on this page.",
      ],
      [
        "Before purchasing",
        "Do not use this page as a quote or purchase offer. Contact your workspace administrator for the terms that apply to your deployment.",
      ],
    ],
  },
  Privacy: {
    draft: true,
    intro:
      "This notice describes data handled by the current Conclave application. The service operator must complete the deployment-specific details below before opening registration to the public.",
    sections: [
      [
        "Information the service stores",
        "Account details include your email address, display name, optional profile photo and bio, plus password hashes and hashed refresh-token records. Collaboration data includes room memberships, messages, replies, reactions, polls and votes, attachments, decisions, tasks, notifications, and read/delivery state.",
      ],
      [
        "How data is used",
        "The application uses this information to authenticate accounts, display conversations and collaboration records, deliver notifications, maintain unread counts, and protect room access. Presence and typing state are used for live room features.",
      ],
      [
        "Files and service providers",
        "Uploaded files are sent to the Cloudinary account configured by the operator. PostgreSQL stores application records and Redis supports realtime delivery and temporary presence state. The operator must identify the actual hosting providers, processing regions, and applicable retention terms for this deployment.",
      ],
      [
        "Your browser",
        "The web client stores access and refresh tokens in browser local storage and may cache recent room messages, uploaded-file copies, and unsent messages in IndexedDB. Signing out or deleting the account clears the application cache on that browser. Clearing browser storage also removes these local copies.",
      ],
      [
        "Deletion and retention",
        "Deleting an account anonymizes its profile, revokes refresh tokens, and removes its room memberships. Messages, decisions, and tasks are retained and shown without the deleted profile identity. The operator must document backup expiry and any separate file-retention schedule.",
      ],
      [
        "Operator details required",
        "Before public launch, add the responsible legal entity, privacy contact, hosting and processor list, data regions, retention periods, and the process for privacy requests. These details depend on the deployment and are not available in the source repository.",
      ],
    ],
  },
  Terms: {
    draft: true,
    intro:
      "These draft terms summarize the product’s intended use. The service operator must complete the legal entity, contact, governing law, and dispute details before treating them as binding terms.",
    sections: [
      [
        "Accounts and access",
        "Keep your sign-in credentials secure and provide accurate account details. Workspace administrators control invitations and membership. Public rooms may be discovered and joined by signed-in users; private rooms require an invitation.",
      ],
      [
        "Your content",
        "You remain responsible for the content you submit and for having permission to share it with the room. Do not upload content that you have no right to use or that violates applicable law.",
      ],
      [
        "Acceptable use",
        "Do not use Conclave to harass people, distribute malware, evade access controls, or interfere with the service or other users. Room access controls do not make a room’s members a substitute for a confidentiality agreement.",
      ],
      [
        "Availability and billing",
        "The application currently has no in-product billing and publishes no uptime commitment. Availability depends on the providers and deployment selected by the operator.",
      ],
      [
        "Account deletion",
        "You can request account deletion through Profile. The account identity and room memberships are removed, while messages, decisions, and tasks remain in anonymized form as described in the privacy notice.",
      ],
      [
        "Operator details required",
        "The operator must add its legal name, support contact, effective date, governing law, dispute process, and any deployment-specific service terms before public launch.",
      ],
    ],
  },
};

export default function StaticPage({ title }) {
  const content = CONTENT[title] || CONTENT.Pricing;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-6 md:px-10 lg:px-16">
          {/* Link, not an anchor: an `<a href="/">` unloads the document and
              re-downloads the bundle for a route that is already mounted. */}
          <Link
            to="/"
            className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            <Logo />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12 md:px-10 md:py-16 lg:px-16">
        <h1 className="font-display text-display-2 text-ink">{title}</h1>
        {content.draft && (
          <p
            role="note"
            className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4 text-body text-ink"
          >
            Draft notice: the service operator must complete the
            deployment-specific details below before public launch.
          </p>
        )}
        <p className="mt-5 max-w-3xl text-body leading-relaxed text-muted">
          {content.intro}
        </p>
        <div className="mt-10 space-y-8">
          {content.sections.map(([heading, body]) => (
            <section key={heading}>
              <h2 className="text-h2 text-ink">{heading}</h2>
              <p className="mt-2 text-body leading-relaxed text-muted">
                {body}
              </p>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
