import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { agentDraft, pollRequest } from "../fixtures.js";
import { copy, fill } from "../screens/copy.js";
import { DecisionBar } from "./DecisionBar.js";
import { Fact, FactList, FactNote, Mono, OptionList } from "./FactList.js";
import { LinkValidity } from "./LinkValidity.js";
import { LocalTime } from "./LocalTime.js";
import { QuestionEditor } from "./QuestionEditor.js";
import { StatusPill } from "./StatusPill.js";

/** The approval page's components (m2-approval-page design.md, Screens A0). */
const meta: Meta = { title: "Components/Approval", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

const column = { display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 } as const;
const c = copy.approval;

function Editor({ initial, readOnly = false }: { initial: string; readOnly?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <form style={column} onSubmit={(e) => e.preventDefault()}>
      <QuestionEditor value={value} onChange={setValue} agentDraft={agentDraft} maxLength={2000} isReadOnly={readOnly} />
    </form>
  );
}

// Question editor
export const QuestionUnchanged: Story = { render: () => <Editor initial={agentDraft} /> };
export const QuestionEdited: Story = {
  render: () => <Editor initial={agentDraft.replace("alarming", "worrying or alarming")} />,
};
export const QuestionEmpty: Story = { render: () => <Editor initial="" /> };
export const QuestionOverLimit: Story = { render: () => <Editor initial={`${agentDraft}\n\n${"More context. ".repeat(130)}`} /> };
export const QuestionReadOnly: Story = { render: () => <Editor initial={agentDraft} readOnly /> };

// Fact list
export const Facts: Story = {
  render: () => (
    <div style={column}>
      <FactList>
        <Fact term={c.to}>
          <span>{pollRequest.participant.label}</span>
          <Mono>{pollRequest.participant.handle}</Mono>
          <FactNote>{c.simulatedNote}</FactNote>
        </Fact>
        <Fact term={c.answerFormat}>
          <span>{c.formats.poll}</span>
          <FactNote>{c.optionsLead}</FactNote>
          <OptionList options={pollRequest.options!} />
          <span>{fill(c.scale, { min: "1", max: "7" })}</span>
        </Fact>
        <Fact term={c.hold}>
          <span>{fill(c.holdAmount, { amount: "€35.00" })}</span>
          <FactNote>{c.holdTerms}</FactNote>
          <FactNote>{fill(c.holdBreakdown, { rate: "15%", net: "€29.75", fee: "€5.25" })}</FactNote>
        </Fact>
        <Fact term={c.expires}>
          <LocalTime iso="2026-11-04T12:20:00+01:00" timeZone="Europe/Paris" />
          <FactNote>{c.expiresNote}</FactNote>
        </Fact>
      </FactList>
    </div>
  ),
};

// Decision bar
const bar = { sendPendingLabel: c.sendPending, dontSendLabel: c.dontSend, dontSendPendingLabel: c.dontSendPending };
const Bar = (props: Partial<Parameters<typeof DecisionBar>[0]>) => (
  <form style={column} onSubmit={(e) => e.preventDefault()}>
    <DecisionBar sendLabel="Send · hold €35.00" {...bar} note={c.decisionNote} {...props} />
  </form>
);
export const DecisionPaid: Story = { render: () => <Bar /> };
/** Less than an hour of the link left: the validity line joins the note (owner decision 2026-11-05). */
export const DecisionLinkEnding: Story = {
  render: () => (
    <Bar
      note={
        <>
          {c.decisionNote}
          <LinkValidity until="2026-11-04T10:20:00+01:00" now="2026-11-04T09:35:00+01:00" timeZone="Europe/Paris" />
        </>
      }
    />
  ),
};
export const DecisionFree: Story = { render: () => <Bar sendLabel={c.sendFree} /> };
export const DecisionSendUnavailable: Story = { render: () => <Bar sendDisabled /> };
export const DecisionSending: Story = { render: () => <Bar pending="send" /> };
export const DecisionCancelling: Story = { render: () => <Bar pending="dont-send" /> };

// Status pills
export const Pills: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <StatusPill tone="pending">{c.pillAwaiting}</StatusPill>
      <StatusPill tone="success">{c.pillSent}</StatusPill>
      <StatusPill tone="neutral">{c.pillNotSent}</StatusPill>
      <StatusPill tone="danger">Blocked</StatusPill>
    </div>
  ),
};
