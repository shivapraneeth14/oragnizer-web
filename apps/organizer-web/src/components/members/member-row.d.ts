interface Member {
    user_id: string;
    role: string;
    joined_at: string;
    email: string | null;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
}
interface Props {
    member: Member;
    currentUserId: string;
    communityId: string;
    onRemoved: () => void;
}
export default function MemberRow({ member, currentUserId, communityId, onRemoved }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=member-row.d.ts.map