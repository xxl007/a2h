import type { Meta, StoryObj } from "@storybook/react-vite";
import { useSimulatedFiles } from "../storybook/simulateFiles.js";
import { chartPng, fileRules, leafletPdf, notesMd, photoUploading, readingsCsv, refusedFiles } from "../fixtures.js";
import { copy } from "../screens/copy.js";
import { DecisionBar } from "./DecisionBar.js";
import { FileAnnouncer, FileList, filesGate, gateText, type ApprovalFile } from "./FileList.js";
import { FileUpload } from "./FileUpload.js";

/** The approval page's file components (m2-attachments design.md, Screens F0). */
const meta: Meta = { title: "Components/Files", parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj;

const column = { display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 } as const;
const c = copy.approval;

function List({ files, mode = "edit" }: { files: ApprovalFile[]; mode?: "edit" | "read" }) {
  return (
    <section style={column} aria-labelledby="files-h">
      <h2 id="files-h" style={{ margin: 0, fontSize: "1rem" }}>
        {mode === "edit" ? c.attachmentsHeading : c.files.sentHeading}
      </h2>
      <FileList files={files} rules={fileRules} mode={mode} aria-labelledby="files-h" />
    </section>
  );
}

// File list, one story per state
export const ItemUploading: Story = { render: () => <List files={[photoUploading]} /> };
export const ItemUploadingStarted: Story = { render: () => <List files={[{ id: "f-jpg0", name: "IMG_2041.jpg", mediaType: "image/jpeg", sizeBytes: 3250586, state: "uploading" }]} /> };
export const ItemChecking: Story = { render: () => <List files={[readingsCsv]} /> };
export const ItemReady: Story = { render: () => <List files={[leafletPdf]} /> };
export const ItemRemoving: Story = { render: () => <List files={[{ ...leafletPdf, removing: true }]} /> };
export const ItemRefusedType: Story = { render: () => <List files={[refusedFiles.type]} /> };
export const ItemRefusedSize: Story = { render: () => <List files={[refusedFiles.size]} /> };
export const ItemRefusedTotal: Story = { render: () => <List files={[refusedFiles.total]} /> };
export const ItemRefusedCount: Story = { render: () => <List files={[refusedFiles.count]} /> };
export const ItemRefusedSecurityCheck: Story = { render: () => <List files={[refusedFiles.malware]} /> };
export const ItemRefusedNotChecked: Story = { render: () => <List files={[refusedFiles.not_checked]} /> };
export const ItemRefusedUploadFailed: Story = { render: () => <List files={[refusedFiles.upload_failed]} /> };
export const ListMixed: Story = { render: () => <List files={[leafletPdf, chartPng, readingsCsv, photoUploading, refusedFiles.malware]} /> };
export const ListAsSent: Story = { render: () => <List mode="read" files={[leafletPdf, chartPng, notesMd]} /> };
/** Stress: a long unbroken name, mixed scripts. */
export const ListLongNames: Story = {
  render: () => (
    <List
      files={[
        { ...leafletPdf, id: "l1", name: "Patient_information_leaflet_GlucoMate_EU_reading-age-12_final_FINAL_v3_reviewed.pdf" },
        { ...chartPng, id: "l2", name: "血糖値チャート 2026年11月.png" },
      ]}
    />
  ),
};

// Upload control
export const UploadAvailable: Story = { render: () => <div style={column}><FileUpload accept={fileRules.accept} /></div> };
export const UploadFull: Story = {
  render: () => (
    <div style={column}>
      <FileUpload accept={fileRules.accept} isDisabled disabledReason={c.files.full.replace("{maxFiles}", "5")} />
    </div>
  ),
};
export const UploadOffline: Story = {
  render: () => (
    <div style={column}>
      <FileUpload accept={fileRules.accept} isDisabled disabledReason={c.files.offline} />
    </div>
  ),
};

// Send gating
const bar = { sendLabel: "Send · hold €35.00", sendPendingLabel: c.sendPending, dontSendLabel: c.dontSend, dontSendPendingLabel: c.dontSendPending, note: c.decisionNote };
const Gate = ({ files }: { files: ApprovalFile[] }) => {
  const gate = filesGate(files);
  const reason = gateText(gate);
  return (
    <form style={column} onSubmit={(e) => e.preventDefault()}>
      <DecisionBar {...bar} sendDisabled={!gate.canSend} {...(reason ? { reason, reasonId: "gate", sendDescribedBy: "gate" } : {})} />
    </form>
  );
};
export const SendGateUploading: Story = { render: () => <Gate files={[leafletPdf, photoUploading]} /> };
export const SendGateChecking: Story = { render: () => <Gate files={[leafletPdf, readingsCsv]} /> };
export const SendGateRefused: Story = { render: () => <Gate files={[leafletPdf, refusedFiles.type, refusedFiles.malware]} /> };
export const SendGateReady: Story = { render: () => <Gate files={[leafletPdf, chartPng]} /> };

/** Interactive list: add, watch the states, remove; the live region text is shown under the list for review. */
export const Interactive: Story = {
  render: function Interactive() {
    const { files, onAddFiles, onRemoveFile } = useSimulatedFiles(fileRules, [leafletPdf]);
    return (
      <div style={column}>
        <section style={column} aria-labelledby="files-i">
          <h2 id="files-i" style={{ margin: 0, fontSize: "1rem" }}>
            {c.attachmentsHeading}
          </h2>
          <FileList files={files} rules={fileRules} mode="edit" aria-labelledby="files-i" onRemove={onRemoveFile} />
          <FileUpload accept={fileRules.accept} onAddFiles={onAddFiles} />
          <FileAnnouncer files={files} rules={fileRules} />
        </section>
      </div>
    );
  },
};
