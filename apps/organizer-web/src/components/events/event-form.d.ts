import type { EventFormData } from "../../hooks/use-events";
interface Props {
    initial?: EventFormData;
    saving: boolean;
    onSave: (data: EventFormData) => Promise<void>;
    onClose: () => void;
}
export default function EventForm({ initial, saving, onSave, onClose }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=event-form.d.ts.map