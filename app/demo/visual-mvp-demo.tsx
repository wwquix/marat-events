"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import styles from "./visual-mvp-demo.module.css";

type DemoView = "event" | "register" | "ticket" | "matching" | "admin";

type Candidate = {
  name: string;
  age: number;
  role: string;
  initials: string;
  detail: string;
  tags: string[];
  accent: "rose" | "violet" | "amber";
};

const navigation: Array<{ id: DemoView; label: string; eyebrow: string }> = [
  { id: "event", label: "Event", eyebrow: "Discover" },
  { id: "register", label: "Register", eyebrow: "Reserve" },
  { id: "ticket", label: "Check-in", eyebrow: "Arrive" },
  { id: "matching", label: "Matches", eyebrow: "Connect" },
  { id: "admin", label: "Admin", eyebrow: "Operate" },
];

const candidates: Candidate[] = [
  {
    name: "Sofia",
    age: 29,
    role: "Product designer",
    initials: "SO",
    detail: "Brooklyn · 2 shared interests",
    tags: ["Design", "Running", "Travel"],
    accent: "rose",
  },
  {
    name: "Maya",
    age: 31,
    role: "Founder",
    initials: "MA",
    detail: "Manhattan · met at table 06",
    tags: ["Startups", "Jazz", "Food"],
    accent: "violet",
  },
  {
    name: "Olivia",
    age: 28,
    role: "Architect",
    initials: "OL",
    detail: "Queens · 1 shared interest",
    tags: ["Architecture", "Tennis", "Coffee"],
    accent: "amber",
  },
];

const attendees = [
  { name: "Daniel Ross", ticket: "Men", status: "Checked in", time: "7:04 PM" },
  { name: "Maya Chen", ticket: "Women", status: "Checked in", time: "7:06 PM" },
  { name: "Sofia Reed", ticket: "Women", status: "Paid", time: "—" },
  { name: "Alex Kim", ticket: "Men", status: "Paid", time: "—" },
];

const qrCells = Array.from({ length: 121 }, (_, index) => {
  const row = Math.floor(index / 11);
  const col = index % 11;
  const inFinder =
    (row < 4 && col < 4) ||
    (row < 4 && col > 6) ||
    (row > 6 && col < 4);

  if (inFinder) {
    const localRow = row > 6 ? row - 7 : row;
    const localCol = col > 6 ? col - 7 : col;
    return localRow === 0 || localCol === 0 || localRow === 3 || localCol === 3 || (localRow === 2 && localCol === 2);
  }

  return (row * 3 + col * 5 + row * col) % 4 < 2;
});

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`${styles.mark} ${small ? styles.markSmall : ""}`} aria-hidden="true">
      M
    </span>
  );
}

function ProgressRail({ active }: { active: DemoView }) {
  const activeIndex = navigation.findIndex((item) => item.id === active);

  return (
    <div className={styles.progressRail} aria-label="Demo flow">
      {navigation.slice(0, 4).map((item, index) => (
        <div className={styles.progressItem} key={item.id}>
          <span className={`${styles.progressDot} ${index <= activeIndex ? styles.progressDotActive : ""}`}>
            {index + 1}
          </span>
          <span className={styles.progressCopy}>
            <strong>{item.label}</strong>
            <small>{item.eyebrow}</small>
          </span>
          {index < 3 ? <span className={`${styles.progressLine} ${index < activeIndex ? styles.progressLineActive : ""}`} /> : null}
        </div>
      ))}
    </div>
  );
}

function EventView({ onReserve, onAdmin }: { onReserve: () => void; onAdmin: () => void }) {
  return (
    <section className={styles.scene}>
      <div className={styles.heroGrid}>
        <div className={styles.heroCopy}>
          <div className={styles.kickerRow}>
            <span className={styles.liveDot} />
            <span>Saturday · September 19 · SoHo</span>
          </div>
          <h1>
            Dating events that feel <span>worth showing up for.</span>
          </h1>
          <p className={styles.heroLead}>
            Curated guest lists, balanced rooms, effortless check-in and private mutual matches after the night ends.
          </p>
          <div className={styles.heroActions}>
            <button className={styles.primaryButton} onClick={onReserve} type="button">
              Reserve a seat <span>→</span>
            </button>
            <button className={styles.secondaryButton} onClick={onAdmin} type="button">
              Open operator demo
            </button>
          </div>
          <div className={styles.trustRow}>
            <span>Curated guests</span>
            <span>Private matching</span>
            <span>Secure checkout</span>
          </div>
        </div>

        <div className={styles.eventCardWrap}>
          <div className={styles.eventGlow} />
          <article className={styles.eventCard}>
            <div className={styles.eventCardTopline}>
              <span className={styles.eventBadge}>Next event</span>
              <span className={styles.eventSpots}>12 seats left</span>
            </div>
            <div className={styles.eventVisual}>
              <div className={styles.eventVisualOrbOne} />
              <div className={styles.eventVisualOrbTwo} />
              <div className={styles.eventInitials}>
                <span>SR</span>
                <span>MC</span>
                <span>AK</span>
                <span>+36</span>
              </div>
              <p>NYC</p>
            </div>
            <div className={styles.eventCardBody}>
              <div>
                <p className={styles.miniLabel}>MARAT SOCIAL CLUB</p>
                <h2>Singles Night — SoHo</h2>
              </div>
              <div className={styles.eventFacts}>
                <div><span>Date</span><strong>Sep 19 · 7:00 PM</strong></div>
                <div><span>Venue</span><strong>SoHo, Manhattan</strong></div>
              </div>
              <div className={styles.balanceCard}>
                <div>
                  <span>Room balance</span>
                  <strong>20 women · 20 men</strong>
                </div>
                <div className={styles.balanceBar}>
                  <span className={styles.balanceWomen} />
                  <span className={styles.balanceMen} />
                </div>
              </div>
              <button className={styles.cardButton} onClick={onReserve} type="button">
                View tickets <span>↗</span>
              </button>
            </div>
          </article>
        </div>
      </div>

      <div className={styles.howGrid}>
        {[
          ["01", "Reserve", "Choose the right ticket and register in under a minute."],
          ["02", "Show up", "Your QR ticket turns arrival into a one-scan check-in."],
          ["03", "Choose privately", "After the event, tell us who you would like to meet again."],
          ["04", "Match mutually", "Contact details unlock only when interest goes both ways."],
        ].map(([number, title, description]) => (
          <article className={styles.howCard} key={number}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function RegisterView({ onComplete }: { onComplete: () => void }) {
  const [ticket, setTicket] = useState<"women" | "men">("women");
  const [name, setName] = useState("Sofia Reed");
  const price = ticket === "women" ? 45 : 49;

  return (
    <section className={styles.scene}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.miniLabel}>GUEST EXPERIENCE · STEP 01</p>
          <h1>Reserve your place.</h1>
          <p>Fast enough for a mobile checkout, clear enough to avoid ticket mistakes.</p>
        </div>
        <span className={styles.prototypePill}>Interactive prototype</span>
      </div>

      <div className={styles.checkoutGrid}>
        <div className={styles.formPanel}>
          <div className={styles.formStepHeader}>
            <span>1</span>
            <div><strong>Your ticket</strong><small>Audience rules stay explicit</small></div>
          </div>
          <div className={styles.ticketOptions}>
            <button className={`${styles.ticketChoice} ${ticket === "women" ? styles.ticketChoiceActive : ""}`} onClick={() => setTicket("women")} type="button">
              <span>Women</span><strong>$45</strong><small>8 seats remaining</small>
            </button>
            <button className={`${styles.ticketChoice} ${ticket === "men" ? styles.ticketChoiceActive : ""}`} onClick={() => setTicket("men")} type="button">
              <span>Men</span><strong>$49</strong><small>4 seats remaining</small>
            </button>
          </div>

          <div className={styles.formDivider} />

          <div className={styles.formStepHeader}>
            <span>2</span>
            <div><strong>Your details</strong><small>Used for ticketing and event operations</small></div>
          </div>
          <div className={styles.inputGrid}>
            <label className={styles.fieldFull}>
              <span>Full name</span>
              <input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label>
              <span>Email</span>
              <input defaultValue="sofia@example.com" type="email" />
            </label>
            <label>
              <span>Phone</span>
              <input defaultValue="+1 917 555 0142" type="tel" />
            </label>
            <label>
              <span>Age</span>
              <input defaultValue="29" type="number" />
            </label>
            <label>
              <span>Gender</span>
              <select defaultValue={ticket === "women" ? "female" : "male"} key={ticket}>
                <option value="female">Woman</option>
                <option value="male">Man</option>
              </select>
            </label>
          </div>

          <button className={`${styles.primaryButton} ${styles.fullButton}`} onClick={onComplete} type="button">
            Continue to payment <span>→</span>
          </button>
          <p className={styles.formFootnote}>Demo mode: no payment or personal data is actually submitted.</p>
        </div>

        <aside className={styles.orderPanel}>
          <p className={styles.miniLabel}>ORDER SUMMARY</p>
          <h2>Singles Night — SoHo</h2>
          <div className={styles.orderMeta}>
            <div><span>Saturday</span><strong>Sep 19 · 7:00 PM</strong></div>
            <div><span>Location</span><strong>SoHo, Manhattan</strong></div>
            <div><span>Guest</span><strong>{name || "Your name"}</strong></div>
          </div>
          <div className={styles.orderTotal}>
            <span>{ticket === "women" ? "Women" : "Men"} ticket</span>
            <strong>${price}.00</strong>
          </div>
          <div className={styles.secureNote}>
            <span>✓</span>
            <p><strong>Safe payment state</strong><br />Production checkout stays on verified Stripe infrastructure.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function TicketView({ onMatching }: { onMatching: () => void }) {
  const [checkedIn, setCheckedIn] = useState(false);

  return (
    <section className={styles.scene}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.miniLabel}>GUEST EXPERIENCE · STEP 02</p>
          <h1>{checkedIn ? "You’re in." : "Your night starts here."}</h1>
          <p>{checkedIn ? "One scan updates attendance instantly and safely." : "A clean mobile ticket for a fast door experience."}</p>
        </div>
        <span className={`${styles.statusPill} ${checkedIn ? styles.statusPillSuccess : ""}`}>
          <span /> {checkedIn ? "Checked in · 7:04 PM" : "Ready to scan"}
        </span>
      </div>

      <div className={styles.ticketScene}>
        <article className={`${styles.mobileTicket} ${checkedIn ? styles.mobileTicketChecked : ""}`}>
          <div className={styles.mobileTicketHeader}>
            <Mark small />
            <span>MARAT EVENTS</span>
            <small>ME-0919-024</small>
          </div>
          <div className={styles.ticketTitleBlock}>
            <p>SEP 19 · MANHATTAN</p>
            <h2>Singles Night<br />SoHo</h2>
            <span>Doors 6:45 PM · Starts 7:00 PM</span>
          </div>
          <div className={styles.qrWrap} aria-label="Demo QR code">
            <div className={styles.qrGrid}>
              {qrCells.map((isDark, index) => <span className={isDark ? styles.qrDark : ""} key={index} />)}
            </div>
          </div>
          <div className={styles.ticketGuest}>
            <div><span>Guest</span><strong>Sofia Reed</strong></div>
            <div><span>Ticket</span><strong>Women · General</strong></div>
          </div>
          <div className={styles.ticketHint}>Keep this screen ready at the door</div>
        </article>

        <div className={styles.checkinPanel}>
          <p className={styles.miniLabel}>DOOR MODE</p>
          <h2>{checkedIn ? "Check-in confirmed" : "Scan once. Know instantly."}</h2>
          <p>
            {checkedIn
              ? "Attendance is now attached to this event registration. Duplicate scans can be detected without losing audit history."
              : "The operator gets a clear valid / already checked in / invalid result instead of searching spreadsheets at the door."}
          </p>
          <div className={styles.checkinMock}>
            <div className={styles.scanLine} />
            <div className={styles.scanAvatar}>SR</div>
            <div>
              <strong>Sofia Reed</strong>
              <span>Women · General Admission</span>
            </div>
            <b>{checkedIn ? "VALID · CHECKED IN" : "READY"}</b>
          </div>
          {!checkedIn ? (
            <button className={styles.primaryButton} onClick={() => setCheckedIn(true)} type="button">Simulate scan <span>→</span></button>
          ) : (
            <button className={styles.primaryButton} onClick={onMatching} type="button">Open post-event matching <span>→</span></button>
          )}
        </div>
      </div>
    </section>
  );
}

function MatchingView() {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [liked, setLiked] = useState<string[]>([]);
  const [showMatch, setShowMatch] = useState(false);
  const candidate = candidates[candidateIndex % candidates.length];
  const accentClass = candidate.accent === "rose" ? styles.accentRose : candidate.accent === "violet" ? styles.accentViolet : styles.accentAmber;

  function nextCandidate() {
    setCandidateIndex((value) => (value + 1) % candidates.length);
  }

  function likeCandidate() {
    setLiked((current) => current.includes(candidate.name) ? current : [...current, candidate.name]);
    if (candidate.name === "Maya") {
      setShowMatch(true);
      return;
    }
    setTimeout(nextCandidate, 220);
  }

  return (
    <section className={styles.scene}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.miniLabel}>GUEST EXPERIENCE · STEP 03</p>
          <h1>Private interest. Mutual reveal.</h1>
          <p>No one sees a one-sided like. Contact details are released only after a mutual match.</p>
        </div>
        <span className={styles.prototypePill}>{liked.length} interested</span>
      </div>

      <div className={styles.matchingGrid}>
        <div className={styles.profileStage}>
          <div className={`${styles.profileBackdrop} ${accentClass}`} />
          <article className={styles.profileCard} key={candidate.name}>
            <div className={`${styles.profilePortrait} ${accentClass}`}>
              <span>{candidate.initials}</span>
              <small>Met tonight</small>
            </div>
            <div className={styles.profileBody}>
              <div>
                <h2>{candidate.name}, {candidate.age}</h2>
                <p>{candidate.role}</p>
              </div>
              <span className={styles.profileDetail}>{candidate.detail}</span>
              <div className={styles.tagRow}>{candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            </div>
          </article>
          <div className={styles.matchActions}>
            <button className={styles.passButton} onClick={nextCandidate} type="button">Skip</button>
            <button className={styles.likeButton} onClick={likeCandidate} type="button">Interested <span>♥</span></button>
          </div>
        </div>

        <aside className={styles.privacyPanel}>
          <p className={styles.miniLabel}>PRIVACY BY DESIGN</p>
          <h2>Interest stays one-way until it isn’t.</h2>
          <div className={styles.privacySteps}>
            <div><span>1</span><p><strong>You choose privately</strong><br />Your selection is never shown as a public vote.</p></div>
            <div><span>2</span><p><strong>The system compares</strong><br />Only same-event eligible participants are evaluated.</p></div>
            <div><span>3</span><p><strong>Mutual match unlocks</strong><br />Both people can receive the approved contact details.</p></div>
          </div>
        </aside>
      </div>

      {showMatch ? (
        <div className={styles.matchOverlay} role="dialog" aria-modal="true" aria-label="Mutual match demo">
          <div className={styles.matchBurstOne} />
          <div className={styles.matchBurstTwo} />
          <div className={styles.matchModal}>
            <span className={styles.matchHeart}>♥</span>
            <p className={styles.miniLabel}>MUTUAL MATCH</p>
            <h2>You and Maya chose each other.</h2>
            <p>Now both of you can receive the contact details allowed by the event policy.</p>
            <div className={styles.matchPeople}>
              <div><span>SR</span><strong>You</strong></div>
              <b>↔</b>
              <div><span>MA</span><strong>Maya</strong></div>
            </div>
            <button className={styles.primaryButton} onClick={() => { setShowMatch(false); nextCandidate(); }} type="button">View next person <span>→</span></button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MiniSparkline() {
  return (
    <svg className={styles.sparkline} viewBox="0 0 160 48" role="img" aria-label="Upward registration trend">
      <path d="M2 39 C18 35, 21 26, 38 29 S62 37, 78 23 S104 26, 118 13 S143 16, 158 4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M2 39 C18 35, 21 26, 38 29 S62 37, 78 23 S104 26, 118 13 S143 16, 158 4 L158 48 L2 48 Z" fill="currentColor" opacity="0.08" />
    </svg>
  );
}

function AdminView() {
  const [checkedInCount, setCheckedInCount] = useState(31);
  const [invitesSent, setInvitesSent] = useState(418);

  const capacityPercent = Math.round((38 / 40) * 100);
  const checkinPercent = Math.round((checkedInCount / 38) * 100);

  return (
    <section className={styles.scene}>
      <div className={styles.adminTopbar}>
        <div>
          <p className={styles.miniLabel}>OPERATOR WORKSPACE</p>
          <h1>Saturday overview</h1>
          <p>One place for guest balance, invitations, payment state, arrivals and match outcomes.</p>
        </div>
        <div className={styles.adminActions}>
          <button className={styles.secondaryButton} onClick={() => setInvitesSent((value) => value + 12)} type="button">Run invite demo</button>
          <button className={styles.primaryButton} onClick={() => setCheckedInCount((value) => Math.min(38, value + 1))} type="button">Simulate check-in <span>+</span></button>
        </div>
      </div>

      <div className={styles.kpiGrid}>
        <article className={styles.kpiCard}>
          <span>Paid registrations</span><strong>38</strong><small>of 40 capacity · {capacityPercent}%</small><MiniSparkline />
        </article>
        <article className={styles.kpiCard}>
          <span>Gender balance</span><strong>20 / 18</strong><small>Women / Men · within target</small>
          <div className={styles.miniBalance}><i style={{ width: "52.6%" }} /><b /></div>
        </article>
        <article className={styles.kpiCard}>
          <span>Checked in</span><strong>{checkedInCount}</strong><small>{checkinPercent}% of paid guests</small>
          <div className={styles.radial} style={{ "--progress": `${checkinPercent * 3.6}deg` } as CSSProperties}><span>{checkinPercent}%</span></div>
        </article>
        <article className={styles.kpiCard}>
          <span>Invitations</span><strong>{invitesSent}</strong><small>42.1% registration conversion</small>
          <div className={styles.deliveryRow}><span>Delivered 96%</span><span>Opt-outs 3</span></div>
        </article>
      </div>

      <div className={styles.adminGrid}>
        <article className={styles.opsCard}>
          <div className={styles.cardHeadingRow}>
            <div><p className={styles.miniLabel}>LIVE EVENT</p><h2>Singles Night — SoHo</h2></div>
            <span className={styles.eventBadge}>Published</span>
          </div>
          <div className={styles.funnelList}>
            {[
              ["Audience eligible", "552", 100],
              ["Invited", String(invitesSent), 76],
              ["Registered", "38", 42],
              ["Checked in", String(checkedInCount), checkinPercent],
              ["Mutual matches", "11", 29],
            ].map(([label, value, width]) => (
              <div className={styles.funnelRow} key={label as string}>
                <span>{label}</span><strong>{value}</strong>
                <div><i style={{ width: `${width}%` }} /></div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.opsCard}>
          <div className={styles.cardHeadingRow}>
            <div><p className={styles.miniLabel}>AUTOMATION</p><h2>Invite pipeline</h2></div>
            <span className={styles.safePill}>DRY RUN SAFE</span>
          </div>
          <div className={styles.pipeline}>
            <div className={styles.pipelineDone}><span>01</span><p><strong>Segment audience</strong><small>552 eligible contacts</small></p><b>✓</b></div>
            <div className={styles.pipelineDone}><span>02</span><p><strong>Policy checks</strong><small>Consent + suppression + channel</small></p><b>✓</b></div>
            <div className={styles.pipelineActive}><span>03</span><p><strong>Outbox preview</strong><small>{invitesSent} messages staged</small></p><b>→</b></div>
            <div><span>04</span><p><strong>Provider delivery</strong><small>Controlled send after approval</small></p><b>○</b></div>
          </div>
        </article>
      </div>

      <article className={styles.tableCard}>
        <div className={styles.cardHeadingRow}>
          <div><p className={styles.miniLabel}>ATTENDEES</p><h2>Door list</h2></div>
          <div className={styles.tableFilters}><span>All 38</span><span>Paid</span><span>Checked in</span></div>
        </div>
        <div className={styles.attendeeTable}>
          <div className={`${styles.attendeeRow} ${styles.attendeeHeader}`}><span>Guest</span><span>Ticket</span><span>Status</span><span>Check-in</span></div>
          {attendees.map((attendee, index) => {
            const simulated = index === 2 && checkedInCount > 31;
            return (
              <div className={styles.attendeeRow} key={attendee.name}>
                <span><i>{attendee.name.split(" ").map((part) => part[0]).join("")}</i><strong>{attendee.name}</strong></span>
                <span>{attendee.ticket}</span>
                <span><b className={(attendee.status === "Checked in" || simulated) ? styles.stateGreen : styles.stateNeutral}>{simulated ? "Checked in" : attendee.status}</b></span>
                <span>{simulated ? "Now" : attendee.time}</span>
              </div>
            );
          })}
        </div>
      </article>
    </section>
  );
}

export function VisualMvpDemo() {
  const [view, setView] = useState<DemoView>("event");
  const activeIndex = useMemo(() => navigation.findIndex((item) => item.id === view), [view]);

  return (
    <main className={styles.shell}>
      <div className={styles.ambientOne} />
      <div className={styles.ambientTwo} />

      <header className={styles.header}>
        <button className={styles.brand} onClick={() => setView("event")} type="button" aria-label="Marat Events demo home">
          <Mark />
          <span><strong>MARAT</strong><small>EVENTS</small></span>
        </button>

        <nav className={styles.nav} aria-label="Visual MVP sections">
          {navigation.map((item) => (
            <button className={view === item.id ? styles.navActive : ""} key={item.id} onClick={() => setView(item.id)} type="button">
              <small>{item.eyebrow}</small><span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.demoLabel}><span /> Visual MVP</div>
      </header>

      <div className={styles.mobileNav}>
        {navigation.map((item, index) => (
          <button className={view === item.id ? styles.mobileNavActive : ""} key={item.id} onClick={() => setView(item.id)} type="button">
            <span>{index + 1}</span>{item.label}
          </button>
        ))}
      </div>

      {view !== "admin" ? <ProgressRail active={view} /> : null}

      <div className={styles.sceneFrame} key={`${view}-${activeIndex}`}>
        {view === "event" ? <EventView onReserve={() => setView("register")} onAdmin={() => setView("admin")} /> : null}
        {view === "register" ? <RegisterView onComplete={() => setView("ticket")} /> : null}
        {view === "ticket" ? <TicketView onMatching={() => setView("matching")} /> : null}
        {view === "matching" ? <MatchingView /> : null}
        {view === "admin" ? <AdminView /> : null}
      </div>

      <footer className={styles.footer}>
        <span>Marat Events · prototype only</span>
        <span>Frontend interactions use mock data; production backend remains separate.</span>
      </footer>
    </main>
  );
}
