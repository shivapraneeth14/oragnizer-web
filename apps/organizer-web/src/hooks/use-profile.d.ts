import type { Profile, Community } from "shared";
export declare function useProfile(): {
    profile: Profile | null;
    community: Community | null;
    loading: boolean;
    saving: boolean;
    error: string | null;
    success: string | null;
    updateProfile: (updates: Partial<Profile>) => Promise<void>;
    updateBanner: (banner_url: string) => Promise<void>;
    updateCommunity: (updates: Record<string, unknown>) => Promise<void>;
    clearMessages: () => void;
};
//# sourceMappingURL=use-profile.d.ts.map