import { type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
interface AuthState {
    user: User | null;
    session: Session | null;
    loading: boolean;
    error: string | null;
    success: string | null;
    isRecovery: boolean;
    otpSent: boolean;
    otpVerified: boolean;
}
interface AuthContextType extends AuthState {
    signIn: (email: string, password: string) => Promise<void>;
    signInWithGoogle: () => Promise<void>;
    signOut: () => Promise<void>;
    sendResetLink: (email: string) => Promise<void>;
    resetPassword: (password: string, onSuccess?: () => void) => Promise<void>;
    checkUsername: (username: string) => Promise<boolean>;
    checkCommunityName: (name: string) => Promise<boolean>;
    clearMessages: () => void;
}
export declare function AuthProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useAuth(): AuthContextType;
export {};
//# sourceMappingURL=auth-context.d.ts.map