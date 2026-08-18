import {
  createAudienceSegmentAction,
  updateAudienceSegmentAction,
} from "./actions";

type SegmentFormValue = {
  id: string;
  name: string;
  description: string;
  gender: "male" | "female" | null;
  city: string | null;
  source: string | null;
  import_batch_id: string | null;
  contact_channel: string | null;
  consent_requirement: string;
  contactability_requirement: string;
  prior_registration_event_id: string | null;
  prior_registration_payment_status: string;
  version: number;
};

type Option = { id: string; label: string };

const inputClass = "mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const labelClass = "text-sm font-medium text-stone-700";

export function SegmentForm({
  segment,
  imports,
  events,
}: {
  segment?: SegmentFormValue;
  imports: Option[];
  events: Option[];
}) {
  const editing = Boolean(segment);
  return (
    <form action={editing ? updateAudienceSegmentAction : createAudienceSegmentAction} className="space-y-6">
      {segment ? (
        <>
          <input name="segment_id" type="hidden" value={segment.id} />
          <input name="version" type="hidden" value={segment.version} />
        </>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          Segment name
          <input className={inputClass} defaultValue={segment?.name ?? ""} maxLength={160} name="name" required />
        </label>
        <label className={labelClass}>
          Gender
          <select className={inputClass} defaultValue={segment?.gender ?? ""} name="gender">
            <option value="">Any</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
      </div>

      <label className={labelClass}>
        Description
        <textarea
          className={`${inputClass} min-h-24 resize-y`}
          defaultValue={segment?.description ?? ""}
          maxLength={2000}
          name="description"
        />
      </label>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          City (exact, case-insensitive)
          <input className={inputClass} defaultValue={segment?.city ?? ""} maxLength={120} name="city" />
        </label>
        <label className={labelClass}>
          Source (exact, case-insensitive)
          <input className={inputClass} defaultValue={segment?.source ?? ""} maxLength={160} name="source" />
        </label>
      </div>

      <label className={labelClass}>
        Import batch
        <select className={inputClass} defaultValue={segment?.import_batch_id ?? ""} name="import_batch_id">
          <option value="">Any</option>
          {imports.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>

      <fieldset className="rounded-lg border border-stone-200 p-4">
        <legend className="px-1 text-sm font-semibold text-stone-800">Contact criteria</legend>
        <p className="mb-4 text-xs leading-5 text-stone-500">
          Consent and contactability filters apply to the selected channel. Unknown values remain explicit; they are
          never sufficient for an event selection&apos;s required delivery channel.
        </p>
        <div className="grid gap-5 sm:grid-cols-3">
          <label className={labelClass}>
            Channel
            <select className={inputClass} defaultValue={segment?.contact_channel ?? ""} name="contact_channel">
              <option value="">Any</option>
              {['email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram'].map((channel) => (
                <option key={channel} value={channel}>{channel}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Consent
            <select className={inputClass} defaultValue={segment?.consent_requirement ?? "any"} name="consent_requirement">
              <option value="any">Any (unknown is warned)</option>
              <option value="opted_in">Opted in</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className={labelClass}>
            Contactability
            <select
              className={inputClass}
              defaultValue={segment?.contactability_requirement ?? "any"}
              name="contactability_requirement"
            >
              <option value="any">Any (unknown is warned)</option>
              <option value="reachable">Reachable</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-stone-200 p-4">
        <legend className="px-1 text-sm font-semibold text-stone-800">Prior registration</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className={labelClass}>
            Event
            <select
              className={inputClass}
              defaultValue={segment?.prior_registration_event_id ?? ""}
              name="prior_registration_event_id"
            >
              <option value="">Any history</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.label}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Payment status
            <select
              className={inputClass}
              defaultValue={segment?.prior_registration_payment_status ?? "any"}
              name="prior_registration_payment_status"
            >
              <option value="any">Any registration status</option>
              <option value="paid">Paid only</option>
            </select>
          </label>
        </div>
        <p className="mt-3 text-xs text-stone-500">Attendance is not filterable because attendance data does not exist yet.</p>
      </fieldset>

      <button className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
        {editing ? "Save segment" : "Create segment"}
      </button>
    </form>
  );
}

export type { Option, SegmentFormValue };
