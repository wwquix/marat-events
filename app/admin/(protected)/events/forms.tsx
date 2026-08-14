import {
  formatCentsForInput,
  utcToNewYorkLocalInput,
  type EventStatus,
  type TicketAudience,
  type TicketStatus,
} from "@/lib/admin/events";

import {
  createEventAction,
  createTicketAction,
  updateEventAction,
  updateTicketAction,
} from "./actions";

const inputClass =
  "mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none focus:border-stone-600";
const labelClass = "block text-sm font-medium text-stone-700";

export type EventFormValue = {
  id: string;
  slug: string;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  capacity: number | null;
  status: EventStatus;
};

export type TicketFormValue = {
  id: string;
  code: string;
  name: string;
  audience: TicketAudience;
  price_cents: number;
  currency: string;
  capacity: number | null;
  status: TicketStatus;
  paidCount: number;
};

export function EventForm({ event }: { event?: EventFormValue }) {
  const isEditing = Boolean(event);
  return (
    <form action={isEditing ? updateEventAction : createEventAction} className="space-y-5">
      {event ? <input name="event_id" type="hidden" value={event.id} /> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          Slug
          <input
            className={inputClass}
            defaultValue={event?.slug ?? ""}
            maxLength={120}
            name="slug"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            placeholder="marats-summer-mixer"
            required
          />
        </label>

        <label className={labelClass}>
          Status
          <select className={inputClass} defaultValue={event?.status ?? "draft"} name="status">
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
      </div>

      <label className={labelClass}>
        Title
        <input
          className={inputClass}
          defaultValue={event?.title ?? ""}
          maxLength={160}
          name="title"
          required
        />
      </label>

      <label className={labelClass}>
        Description
        <textarea
          className={`${inputClass} min-h-28 resize-y`}
          defaultValue={event?.description ?? ""}
          maxLength={5000}
          name="description"
        />
      </label>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          Venue
          <input
            className={inputClass}
            defaultValue={event?.venue ?? ""}
            maxLength={240}
            name="venue"
            required
          />
        </label>

        <label className={labelClass}>
          Capacity
          <input
            className={inputClass}
            defaultValue={event?.capacity ?? ""}
            max="100000"
            min="0"
            name="capacity"
            placeholder="Unlimited if blank"
            type="number"
          />
        </label>
      </div>

      <label className={labelClass}>
        Date and time — New York
        <input
          className={inputClass}
          defaultValue={event ? utcToNewYorkLocalInput(event.starts_at) : ""}
          name="starts_at"
          required
          type="datetime-local"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
          type="submit"
        >
          {isEditing ? "Save event" : "Create event"}
        </button>
        <span className="text-xs text-stone-500">Times are stored in UTC and shown as America/New_York.</span>
      </div>
    </form>
  );
}

export function TicketForm({ eventId, ticket }: { eventId: string; ticket?: TicketFormValue }) {
  const isEditing = Boolean(ticket);
  const immutableAfterPayment = Boolean(ticket && ticket.paidCount > 0);

  return (
    <form
      action={isEditing ? updateTicketAction : createTicketAction}
      className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <input name="event_id" type="hidden" value={eventId} />
      {ticket ? <input name="ticket_id" type="hidden" value={ticket.id} /> : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-stone-900">{isEditing ? ticket?.name : "New ticket"}</h3>
          {ticket ? (
            <p className="mt-1 text-xs text-stone-500">
              {ticket.paidCount} paid registration{ticket.paidCount === 1 ? "" : "s"}
            </p>
          ) : (
            <p className="mt-1 text-xs text-stone-500">Add a sellable ticket type to this event.</p>
          )}
        </div>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
          type="submit"
        >
          {isEditing ? "Save ticket" : "Add ticket"}
        </button>
      </div>

      {immutableAfterPayment ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Code, audience, price and currency are locked because this ticket has paid registrations.
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>
          Code
          <input
            className={inputClass}
            defaultValue={ticket?.code ?? ""}
            maxLength={80}
            name="code"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            readOnly={immutableAfterPayment}
            required
          />
        </label>

        <label className={labelClass}>
          Name
          <input
            className={inputClass}
            defaultValue={ticket?.name ?? ""}
            maxLength={160}
            name="name"
            required
          />
        </label>

        <label className={labelClass}>
          Audience
          <select
            className={inputClass}
            defaultValue={ticket?.audience ?? "any"}
            disabled={immutableAfterPayment}
            name="audience"
          >
            <option value="any">All guests</option>
            <option value="male">Men</option>
            <option value="female">Women</option>
          </select>
          {immutableAfterPayment ? <input name="audience" type="hidden" value={ticket?.audience} /> : null}
        </label>

        <label className={labelClass}>
          Status
          <select className={inputClass} defaultValue={ticket?.status ?? "active"} name="status">
            <option value="active">Active</option>
            <option value="sold_out">Sold out</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>

        <label className={labelClass}>
          Price
          <input
            className={inputClass}
            defaultValue={ticket ? formatCentsForInput(ticket.price_cents) : "25.00"}
            inputMode="decimal"
            name="price"
            readOnly={immutableAfterPayment}
            required
          />
        </label>

        <label className={labelClass}>
          Currency
          <input
            className={inputClass}
            defaultValue={ticket?.currency ?? "USD"}
            maxLength={3}
            minLength={3}
            name="currency"
            readOnly={immutableAfterPayment}
            required
          />
        </label>

        <label className={labelClass}>
          Capacity
          <input
            className={inputClass}
            defaultValue={ticket?.capacity ?? ""}
            max="100000"
            min="0"
            name="capacity"
            placeholder="Unlimited if blank"
            type="number"
          />
        </label>
      </div>
    </form>
  );
}
