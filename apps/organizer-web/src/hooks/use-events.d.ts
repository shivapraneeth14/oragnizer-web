import type { Event } from "shared";
export type EventFormData = {
    title: string;
    description: string;
    image_url: string;
    start_date: string;
    end_date: string;
    location: string;
    capacity: string;
    price: string;
    status: "draft" | "published";
};
export declare const emptyForm: EventFormData;
export declare function eventToForm(e: Event): EventFormData;
export declare function useEvents(communityId: string | undefined): {
    events: Event[];
    loading: boolean;
    loadingMore: boolean;
    hasMore: boolean;
    error: string | null;
    createEvent: (data: EventFormData, userId: string) => Promise<string | null>;
    updateEvent: (id: string, data: EventFormData) => Promise<string | null>;
    cancelEvent: (id: string) => Promise<string | null>;
    refresh: (append?: boolean) => Promise<void>;
    fetchNextPage: () => Promise<void>;
};
//# sourceMappingURL=use-events.d.ts.map