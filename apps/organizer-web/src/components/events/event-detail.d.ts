import type { Event } from "shared";
interface Props {
    event: Event;
    onEdit: () => void;
    onCancel: () => void;
    onClose: () => void;
}
export default function EventDetail({ event, onEdit, onCancel, onClose }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=event-detail.d.ts.map