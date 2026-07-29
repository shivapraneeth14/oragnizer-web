import "react-phone-number-input/style.css";
export interface CommunityData {
    community_name: string;
    category: string;
    description: string;
    city: string;
    state: string;
    country: string;
    contact_email: string;
    contact_phone: string;
    tags: string[];
    visibility: "public" | "private";
    rules: string;
    agree18: boolean;
    agreeContent: boolean;
}
export declare const initialCommunityData: CommunityData;
interface Props {
    data: CommunityData;
    onChange: (data: CommunityData) => void;
    checkName: (name: string) => Promise<boolean>;
    step: 1 | 2;
}
export default function CommunityDetailsForm({ data, onChange, checkName, step }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=community-details-form.d.ts.map