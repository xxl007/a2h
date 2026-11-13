// @a2h/ui: tokens (import "@a2h/ui/tokens.css" and "@a2h/ui/base.css" once), components, screens.
export { Button, ButtonLink, TextLink } from "./components/Button.js";
export type { ButtonProps, ButtonLinkProps, ButtonVariant, TextLinkProps } from "./components/Button.js";
export { TextField } from "./components/TextField.js";
export type { TextFieldProps } from "./components/TextField.js";
export { Notice } from "./components/Notice.js";
export type { NoticeProps, NoticeTone } from "./components/Notice.js";
export { AuthShell } from "./components/AuthShell.js";
export type { AuthShellProps } from "./components/AuthShell.js";
export { ClientIdentity, originLabel, provenanceText, isLocalOrigin } from "./components/ClientIdentity.js";
export { ClientRow } from "./components/ClientRow.js";
export type { ClientRowProps, ClientRowState, ConnectedClient } from "./components/ClientRow.js";
export { Skeleton } from "./components/Skeleton.js";
export { QuestionEditor, questionStatus, characters } from "./components/QuestionEditor.js";
export type { QuestionEditorProps, QuestionStatus } from "./components/QuestionEditor.js";
export { Fact, FactList, FactNote, Mono, OptionList } from "./components/FactList.js";
export type { FactListProps, FactProps, OptionListProps } from "./components/FactList.js";
export { DecisionBar } from "./components/DecisionBar.js";
export type { DecisionBarProps } from "./components/DecisionBar.js";
export { StatusPill } from "./components/StatusPill.js";
export type { StatusPillProps, StatusPillTone } from "./components/StatusPill.js";
export { LocalTime } from "./components/LocalTime.js";
export type { LocalTimeProps } from "./components/LocalTime.js";
export { LinkValidity } from "./components/LinkValidity.js";
export type { LinkValidityProps } from "./components/LinkValidity.js";
export { formatDateTime, linkEndsSoon, viewerTimeZone } from "./components/datetime.js";
export { fillNodes } from "./components/fillNodes.js";
export {
  acceptAttribute,
  FileAnnouncer,
  fileAnnouncements,
  fileHint,
  FileList,
  filesFact,
  filesGate,
  fileTypeLabel,
  formatFileSize,
  gateText,
  refusalText,
  typesSentence,
} from "./components/FileList.js";
export type { ApprovalFile, ApprovalFileRefusal, ApprovalFileRules, ApprovalFileState, FileListProps, FilesGate } from "./components/FileList.js";
export { FileUpload } from "./components/FileUpload.js";
export type { FileUploadProps } from "./components/FileUpload.js";
export type { ClientRegistration, ClientSummary, DisplayDate, FormAction, ScopeName } from "./components/types.js";

export { NavLinks } from "./components/NavLinks.js";
export type { NavLinkItem, NavLinksProps } from "./components/NavLinks.js";
export { AdminNav } from "./components/AdminNav.js";
export type { AdminNavProps } from "./components/AdminNav.js";
export { SearchField } from "./components/SearchField.js";
export type { SearchFieldProps } from "./components/SearchField.js";
export { ChoiceGroup } from "./components/ChoiceGroup.js";
export type { ChoiceGroupProps, ChoiceOption } from "./components/ChoiceGroup.js";
export { confirmationCopy, PersonRow } from "./components/PersonRow.js";
export type { PersonRowFocus, PersonRowNotice, PersonRowProps, PersonRowStatus } from "./components/PersonRow.js";
export { ActionRecord } from "./components/ActionRecord.js";
export type { ActionRecordProps } from "./components/ActionRecord.js";
export { countLine, filterPeople, isActiveAdministrator, peopleCounts, personOffers, recordSentence } from "./components/people.js";
export type {
  PeopleShow,
  Person,
  PersonAction,
  PersonActionResult,
  PersonOffers,
  PersonRefusal,
  RecordAction,
  RecordEntry,
} from "./components/people.js";

export { SignInScreen } from "./screens/SignInScreen.js";
export type { SignInMethod, SignInNotice, SignInScreenProps, SignInState } from "./screens/SignInScreen.js";
export { AccessRefusedScreen, administratorContactLine, NotAdministratorScreen } from "./screens/AccessRefusedScreen.js";
export type { AccessRefusedScreenProps, NotAdministratorScreenProps } from "./screens/AccessRefusedScreen.js";
export { PeopleScreen } from "./screens/PeopleScreen.js";
export type { PeopleScreenProps, PeopleState, PersonActionHandler } from "./screens/PeopleScreen.js";
export { RecordScreen } from "./screens/RecordScreen.js";
export type { RecordScreenProps, RecordState } from "./screens/RecordScreen.js";
export { CheckEmailScreen, LinkExpiredScreen } from "./screens/CheckEmailScreen.js";
export type { CheckEmailScreenProps, CheckEmailState, LinkExpiredScreenProps } from "./screens/CheckEmailScreen.js";
export { ConsentScreen } from "./screens/ConsentScreen.js";
export type { ConsentScreenProps, ConsentState } from "./screens/ConsentScreen.js";
export { ConnectedClientsScreen } from "./screens/ConnectedClientsScreen.js";
export type { ConnectedClientsScreenProps, ConnectedClientsState } from "./screens/ConnectedClientsScreen.js";
export { SignedOutScreen } from "./screens/SignedOutScreen.js";
export type { SignedOutScreenProps } from "./screens/SignedOutScreen.js";
export { ApprovalScreen } from "./screens/ApprovalScreen.js";
export type {
  ApprovalFormat,
  ApprovalFilesRefusal,
  ApprovalFreeLane,
  ApprovalIntent,
  ApprovalMoney,
  ApprovalRefusal,
  ApprovalRequest,
  ApprovalScreenProps,
  ApprovalState,
} from "./screens/ApprovalScreen.js";
export { copy, fill, signInWords } from "./screens/copy.js";
