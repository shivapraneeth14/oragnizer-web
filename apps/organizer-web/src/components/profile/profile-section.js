import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../../auth-context";
import { useProfile } from "../../hooks/use-profile";
import { uploadToCloudinary } from "../../lib/cloudinary";
export default function ProfileSection() {
    const { user } = useAuth();
    const { profile, community, loading, saving, error, success, updateProfile, updateBanner, updateCommunity, clearMessages } = useProfile();
    const [editing, setEditing] = useState(false);
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [username, setUsername] = useState("");
    const [uploading, setUploading] = useState(false);
    const [uploadingBanner, setUploadingBanner] = useState(false);
    const avatarInputRef = useRef(null);
    const bannerInputRef = useRef(null);
    const [communityEditing, setCommunityEditing] = useState(false);
    const [commName, setCommName] = useState("");
    const [commDesc, setCommDesc] = useState("");
    const [commCategory, setCommCategory] = useState("");
    const [commCity, setCommCity] = useState("");
    const [commState, setCommState] = useState("");
    const [commCountry, setCommCountry] = useState("");
    const [commEmail, setCommEmail] = useState("");
    const [commPhone, setCommPhone] = useState("");
    const [commVisibility, setCommVisibility] = useState("public");
    useEffect(() => {
        if (profile) {
            setFirstName(profile.first_name || "");
            setLastName(profile.last_name || "");
            setUsername(profile.username || "");
        }
    }, [profile]);
    useEffect(() => {
        if (community) {
            setCommName(community.name || "");
            setCommDesc(community.description || "");
            setCommCategory(community.category || "");
            setCommCity(community.city || "");
            setCommState(community.state || "");
            setCommCountry(community.country || "");
            setCommEmail(community.contact_email || "");
            setCommPhone(community.contact_phone || "");
            setCommVisibility(community.visibility || "public");
        }
    }, [community]);
    useEffect(() => {
        if (success || error) {
            const t = setTimeout(clearMessages, 3000);
            return () => clearTimeout(t);
        }
    }, [success, error, clearMessages]);
    const handleSave = async () => {
        await updateProfile({
            first_name: firstName.trim() || null,
            last_name: lastName.trim() || null,
            username: username.trim() || null,
        });
        setEditing(false);
    };
    const handleCancel = () => {
        if (profile) {
            setFirstName(profile.first_name || "");
            setLastName(profile.last_name || "");
            setUsername(profile.username || "");
        }
        setEditing(false);
    };
    const handleCommunitySave = async () => {
        await updateCommunity({
            name: commName.trim(),
            description: commDesc.trim() || null,
            category: commCategory.trim() || null,
            city: commCity.trim() || null,
            state: commState.trim() || null,
            country: commCountry.trim() || null,
            contact_email: commEmail.trim() || null,
            contact_phone: commPhone.trim() || null,
            visibility: commVisibility,
        });
        setCommunityEditing(false);
    };
    const handleCommunityCancel = () => {
        if (community) {
            setCommName(community.name || "");
            setCommDesc(community.description || "");
            setCommCategory(community.category || "");
            setCommCity(community.city || "");
            setCommState(community.state || "");
            setCommCountry(community.country || "");
            setCommEmail(community.contact_email || "");
            setCommPhone(community.contact_phone || "");
            setCommVisibility(community.visibility || "public");
        }
        setCommunityEditing(false);
    };
    const handleAvatarChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        setUploading(true);
        try {
            const url = await uploadToCloudinary(file);
            await updateProfile({ avatar_url: url });
        }
        catch {
            // upload failed
        }
        finally {
            setUploading(false);
            e.target.value = "";
        }
    };
    const handleBannerChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        setUploadingBanner(true);
        try {
            const url = await uploadToCloudinary(file);
            await updateBanner(url);
        }
        catch {
            // upload failed
        }
        finally {
            setUploadingBanner(false);
            e.target.value = "";
        }
    };
    const formatDate = (dateStr) => {
        return new Date(dateStr).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
        });
    };
    if (loading) {
        return (_jsx("div", { className: "flex items-center justify-center py-20", children: _jsxs("svg", { className: "h-6 w-6 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) }));
    }
    return (_jsxs("div", { className: "mx-auto max-w-2xl", children: [_jsx("input", { ref: bannerInputRef, type: "file", accept: "image/*", onChange: handleBannerChange, className: "hidden" }), _jsxs("button", { onClick: () => bannerInputRef.current?.click(), disabled: uploadingBanner, className: "group relative h-40 w-full overflow-hidden rounded-xl bg-gradient-to-r from-[#C2185B]/20 to-[#C2185B]/5 transition hover:opacity-90 disabled:opacity-50", children: [community?.banner_url ? (_jsx("img", { src: community.banner_url, alt: "", className: "h-full w-full object-cover" })) : null, _jsx("div", { className: "absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/20", children: uploadingBanner ? (_jsxs("svg", { className: "h-6 w-6 animate-spin text-white", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] })) : (_jsx("svg", { className: "h-6 w-6 text-white opacity-0 transition group-hover:opacity-100", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" }) })) })] }), _jsxs("div", { className: "relative -mt-12 ml-8 flex items-end gap-4", children: [_jsxs("div", { className: "relative", children: [_jsx("div", { className: "flex h-24 w-24 items-center justify-center rounded-full border-4 border-white bg-[#C2185B]/20 text-3xl font-bold text-[#C2185B] shadow-md", children: profile?.avatar_url ? (_jsx("img", { src: profile.avatar_url, alt: "", className: "h-full w-full rounded-full object-cover" })) : (user?.email?.charAt(0).toUpperCase() || "U") }), _jsx("input", { ref: avatarInputRef, type: "file", accept: "image/*", onChange: handleAvatarChange, className: "hidden" }), _jsx("button", { onClick: () => avatarInputRef.current?.click(), disabled: uploading, className: "absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-white text-neutral-500 shadow hover:text-[#C2185B] disabled:opacity-50", title: "Change avatar", children: uploading ? (_jsxs("svg", { className: "h-3.5 w-3.5 animate-spin", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] })) : (_jsxs("svg", { className: "h-3.5 w-3.5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: [_jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" }), _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M15 13a3 3 0 11-6 0 3 3 0 016 0z" })] })) })] }), _jsxs("div", { className: "pb-1", children: [_jsx("h3", { className: "text-lg font-semibold text-neutral-900", children: profile?.first_name || profile?.last_name
                                    ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
                                    : "User" }), _jsxs("p", { className: "text-xs text-neutral-400", children: ["@", profile?.username || "username"] })] })] }), error && (_jsx("div", { className: "mx-8 mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600", children: error })), success && (_jsx("div", { className: "mx-8 mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-600", children: success })), _jsxs("div", { className: "mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h4", { className: "text-sm font-semibold text-neutral-700", children: "Profile Information" }), !editing && (_jsxs("button", { onClick: () => setEditing(true), className: "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#C2185B] hover:bg-[#C2185B]/5", children: [_jsx("svg", { className: "h-3.5 w-3.5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" }) }), "Edit"] }))] }), _jsx("div", { className: "mt-5 space-y-4", children: editing ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "First name" }), _jsx("input", { value: firstName, onChange: (e) => setFirstName(e.target.value), placeholder: "First name", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Last name" }), _jsx("input", { value: lastName, onChange: (e) => setLastName(e.target.value), placeholder: "Last name", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Username" }), _jsx("input", { value: username, onChange: (e) => setUsername(e.target.value), placeholder: "username", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "flex gap-2 pt-2", children: [_jsx("button", { onClick: handleSave, disabled: saving, className: "rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: saving ? "Saving..." : "Save changes" }), _jsx("button", { onClick: handleCancel, className: "rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50", children: "Cancel" })] })] })) : (_jsxs(_Fragment, { children: [_jsx(Field, { label: "First name", value: profile?.first_name }), _jsx(Field, { label: "Last name", value: profile?.last_name }), _jsx(Field, { label: "Username", value: profile?.username ? `@${profile.username}` : null }), _jsx(Field, { label: "Email", value: user?.email }), _jsx(Field, { label: "Member since", value: profile?.created_at ? formatDate(profile.created_at) : null })] })) })] }), community && (_jsxs("div", { className: "mt-6 rounded-xl border border-neutral-200 bg-white px-8 py-6 shadow-soft", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h4", { className: "text-sm font-semibold text-neutral-700", children: "Community Information" }), !communityEditing && (_jsxs("button", { onClick: () => setCommunityEditing(true), className: "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#C2185B] hover:bg-[#C2185B]/5", children: [_jsx("svg", { className: "h-3.5 w-3.5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" }) }), "Edit"] }))] }), _jsx("div", { className: "mt-5 space-y-4", children: communityEditing ? (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Community name *" }), _jsx("input", { value: commName, onChange: (e) => setCommName(e.target.value), placeholder: "Community name", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Description" }), _jsx("textarea", { value: commDesc, onChange: (e) => setCommDesc(e.target.value), placeholder: "Describe your community...", rows: 3, className: "w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Category" }), _jsx("input", { value: commCategory, onChange: (e) => setCommCategory(e.target.value), placeholder: "e.g. Arts, Tech, Sports", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Visibility" }), _jsx("div", { className: "flex gap-2 pt-1", children: ["public", "private"].map((v) => (_jsx("button", { type: "button", onClick: () => setCommVisibility(v), className: `rounded-lg px-4 py-1.5 text-xs font-medium transition ${commVisibility === v ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`, children: v.charAt(0).toUpperCase() + v.slice(1) }, v))) })] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "City" }), _jsx("input", { value: commCity, onChange: (e) => setCommCity(e.target.value), placeholder: "City", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "State" }), _jsx("input", { value: commState, onChange: (e) => setCommState(e.target.value), placeholder: "State", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Country" }), _jsx("input", { value: commCountry, onChange: (e) => setCommCountry(e.target.value), placeholder: "Country", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Contact email" }), _jsx("input", { type: "email", value: commEmail, onChange: (e) => setCommEmail(e.target.value), placeholder: "contact@example.com", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-500", children: "Contact phone" }), _jsx("input", { type: "tel", value: commPhone, onChange: (e) => setCommPhone(e.target.value), placeholder: "+91 9876543210", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] })] }), _jsxs("div", { className: "flex gap-2 pt-2", children: [_jsx("button", { onClick: handleCommunitySave, disabled: saving, className: "rounded-lg bg-[#C2185B] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#A0154A] disabled:opacity-50", children: saving ? "Saving..." : "Save changes" }), _jsx("button", { onClick: handleCommunityCancel, className: "rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50", children: "Cancel" })] })] })) : (_jsxs(_Fragment, { children: [_jsx(Field, { label: "Name", value: community.name }), _jsx(Field, { label: "Description", value: community.description }), _jsx(Field, { label: "Category", value: community.category }), _jsx(Field, { label: "City", value: community.city }), _jsx(Field, { label: "State", value: community.state }), _jsx(Field, { label: "Country", value: community.country }), _jsx(Field, { label: "Contact email", value: community.contact_email }), _jsx(Field, { label: "Contact phone", value: community.contact_phone }), _jsx(Field, { label: "Visibility", value: community.visibility })] })) })] }))] }));
}
function Field({ label, value }) {
    return (_jsxs("div", { children: [_jsx("p", { className: "text-xs font-medium text-neutral-500", children: label }), _jsx("p", { className: "mt-0.5 text-sm text-neutral-900", children: value || _jsx("span", { className: "italic text-neutral-400", children: "Not set" }) })] }));
}
//# sourceMappingURL=profile-section.js.map