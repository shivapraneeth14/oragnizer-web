import type { Event } from "shared";
interface Props {
    events: Event[];
    loading: boolean;
    loadingMore?: boolean;
    hasMore?: boolean;
    error?: string | null;
    onLoadMore?: () => void;
    onView: (event: Event) => void;
    onEdit: (event: Event) => void;
    onCancel: (id: string) => void;
    onCreate: () => void;
    onRetry?: () => void;
}
export default function EventList({ events, loading, loadingMore, hasMore, error, onLoadMore, onView, onEdit, onCancel, onCreate, onRetry }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=event-list.d.ts.map