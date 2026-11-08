// Storybook only (not exported from the package): plays the app's side of adding a file, so
// the interactive stories show every state with real chosen files. Rules as m2-attachments D2–D3:
// count and size refused before upload, type refused by the content check, a name containing
// "eicar" refused by the security check, anything else ready after the check.
import { useRef, useState } from "react";
import type { ApprovalFile, ApprovalFileRules } from "../components/FileList.js";

export function useSimulatedFiles(rules: ApprovalFileRules, initial: ApprovalFile[] = []) {
  const [files, setFiles] = useState<ApprovalFile[]>(initial);
  const seq = useRef(0);
  const update = (id: string, patch: Partial<ApprovalFile>) => setFiles((fs) => fs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const onAddFiles = (chosen: File[]) => {
    setFiles((current) => {
      const next = [...current];
      for (const file of chosen) {
        const id = `sim-${(seq.current += 1)}`;
        const base = { id, name: file.name, mediaType: file.type, sizeBytes: file.size };
        const total = next.filter((x) => x.state !== "refused").reduce((s, x) => s + x.sizeBytes, 0);
        if (next.filter((x) => x.state !== "refused").length >= rules.maxFiles) next.push({ ...base, state: "refused", refusal: "count" });
        else if (file.size > rules.maxFileBytes) next.push({ ...base, state: "refused", refusal: "size" });
        else if (total + file.size > rules.maxTotalBytes) next.push({ ...base, state: "refused", refusal: "total" });
        else {
          next.push({ ...base, state: "uploading", progress: 0 });
          const allowed = rules.accept.includes(file.type);
          const flagged = /eicar/i.test(file.name);
          setTimeout(() => update(id, { progress: 0.35 }), 500);
          setTimeout(() => update(id, { progress: 0.8 }), 1000);
          setTimeout(() => update(id, allowed ? { state: "checking" } : { state: "refused", refusal: "type" }), 1500);
          if (allowed) setTimeout(() => update(id, flagged ? { state: "refused", refusal: "malware" } : { state: "ready" }), 3500);
        }
      }
      return next;
    });
  };

  const onRemoveFile = (id: string) => {
    update(id, { removing: true });
    setTimeout(() => setFiles((fs) => fs.filter((x) => x.id !== id)), 400);
  };

  return { files, onAddFiles, onRemoveFile };
}
