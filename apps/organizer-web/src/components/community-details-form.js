import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useRef, useEffect } from "react";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Country, State, City } from "country-state-city";
const categories = [
    "Technology", "Sports & Fitness", "Music & Arts",
    "Education", "Health & Wellness", "Food & Drink",
    "Business & Finance", "Social & Community", "Travel & Outdoors",
    "Gaming", "Photography", "Other",
];
export const initialCommunityData = {
    community_name: "", category: "", description: "",
    city: "", state: "", country: "",
    contact_email: "", contact_phone: "",
    tags: [], visibility: "public", rules: "",
    agree18: false, agreeContent: false,
};
export default function CommunityDetailsForm({ data, onChange, checkName, step }) {
    const [nameAvailable, setNameAvailable] = useState(null);
    const [checkingName, setCheckingName] = useState(false);
    const [tagInput, setTagInput] = useState("");
    const [categoryOpen, setCategoryOpen] = useState(false);
    const nameTimer = useRef(null);
    const update = useCallback((key, value) => {
        onChange({ ...data, [key]: value });
    }, [data, onChange]);
    const countries = Country.getAllCountries();
    const countryCode = data.country;
    const states = countryCode ? State.getStatesOfCountry(countryCode) : [];
    const cities = countryCode && data.state ? City.getCitiesOfState(countryCode, data.state) : [];
    useEffect(() => {
        if (nameTimer.current)
            clearTimeout(nameTimer.current);
        const n = data.community_name.trim();
        if (n.length < 2) {
            setNameAvailable(null);
            setCheckingName(false);
            return;
        }
        setCheckingName(true);
        nameTimer.current = setTimeout(async () => {
            try {
                const avail = await checkName(n);
                setNameAvailable(avail);
            }
            catch {
                setNameAvailable(false);
            }
            finally {
                setCheckingName(false);
            }
        }, 500);
        return () => { if (nameTimer.current)
            clearTimeout(nameTimer.current); };
    }, [data.community_name, checkName]);
    const addTag = () => {
        const t = tagInput.trim().toLowerCase();
        if (t && !data.tags.includes(t)) {
            update("tags", [...data.tags, t]);
        }
        setTagInput("");
    };
    const removeTag = (tag) => {
        update("tags", data.tags.filter((t) => t !== tag));
    };
    return step === 1 ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Community name *" }), _jsxs("div", { className: "relative", children: [_jsx("input", { value: data.community_name, onChange: (e) => update("community_name", e.target.value), placeholder: "My Awesome Community", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" }), _jsx("span", { className: "absolute right-3 top-1/2 -translate-y-1/2", children: checkingName ? (_jsxs("svg", { className: "h-4 w-4 animate-spin text-neutral-400", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] })) : nameAvailable === true ? (_jsx("svg", { className: "h-4 w-4 text-green-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M5 13l4 4L19 7" }) })) : nameAvailable === false ? (_jsx("svg", { className: "h-4 w-4 text-red-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M6 18L18 6M6 6l12 12" }) })) : null })] }), nameAvailable === false && (_jsx("p", { className: "mt-0.5 text-xs text-red-500", children: "This name is already taken" }))] }), _jsxs("div", { className: "relative", children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Category" }), _jsxs("button", { type: "button", onClick: () => setCategoryOpen(!categoryOpen), className: "flex w-full items-center justify-between rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", children: [_jsx("span", { className: data.category ? "text-neutral-900" : "text-neutral-400", children: data.category || "Select a category (optional)" }), _jsx("svg", { className: `h-4 w-4 text-neutral-400 transition-transform ${categoryOpen ? "rotate-180" : ""}`, fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M19 9l-7 7-7-7" }) })] }), categoryOpen && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-10", onClick: () => setCategoryOpen(false) }), _jsxs("div", { className: "absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-medium", children: [_jsx("button", { type: "button", onClick: () => { update("category", ""); setCategoryOpen(false); }, className: `w-full px-3.5 py-2 text-left text-sm hover:bg-neutral-50 ${!data.category ? "bg-[#C2185B]/5 font-medium text-[#C2185B]" : "text-neutral-500"}`, children: "None" }), categories.map((c) => (_jsx("button", { type: "button", onClick: () => { update("category", c); setCategoryOpen(false); }, className: `w-full px-3.5 py-2 text-left text-sm hover:bg-neutral-50 ${data.category === c ? "bg-[#C2185B]/5 font-medium text-[#C2185B]" : "text-neutral-900"}`, children: c }, c)))] })] }))] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Description" }), _jsx("textarea", { value: data.description, onChange: (e) => update("description", e.target.value), placeholder: "Tell people what your community is about...", rows: 2, className: "w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Country" }), _jsxs("select", { value: data.country, onChange: (e) => onChange({ ...data, country: e.target.value, state: "", city: "" }), className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", children: [_jsx("option", { value: "", children: "Country" }), countries.map((c) => (_jsx("option", { value: c.isoCode, children: c.name }, c.isoCode)))] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "State" }), _jsxs("select", { value: data.state, onChange: (e) => onChange({ ...data, state: e.target.value, city: "" }), className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", disabled: !data.country, children: [_jsx("option", { value: "", children: "State" }), states.map((s) => (_jsx("option", { value: s.isoCode, children: s.name }, s.isoCode)))] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "City" }), _jsxs("select", { value: data.city, onChange: (e) => update("city", e.target.value), className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20", disabled: !data.state, children: [_jsx("option", { value: "", children: "City" }), cities.map((c) => (_jsx("option", { value: c.name, children: c.name }, `${c.name}-${c.latitude}-${c.longitude}`)))] })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Contact email" }), _jsx("input", { type: "email", value: data.contact_email, onChange: (e) => update("contact_email", e.target.value), placeholder: "community@example.com", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Contact phone" }), _jsx(PhoneInput, { value: data.contact_phone, onChange: (v) => update("contact_phone", v || ""), defaultCountry: "IN", className: "w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm [&_.PhoneInputInput]:border-0 [&_.PhoneInputInput]:outline-none [&_.PhoneInputCountrySelect]:outline-none" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Tags" }), _jsxs("div", { className: "flex flex-wrap gap-1.5 rounded-lg border border-neutral-300 px-3.5 py-2", children: [data.tags.map((tag) => (_jsxs("span", { className: "flex items-center gap-1 rounded-full bg-[#C2185B]/10 px-2.5 py-0.5 text-xs font-medium text-[#C2185B]", children: [tag, _jsx("button", { type: "button", onClick: () => removeTag(tag), className: "hover:text-[#A0154A]", children: "\u00D7" })] }, tag))), _jsx("input", { value: tagInput, onChange: (e) => setTagInput(e.target.value), onKeyDown: (e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addTag();
                                    }
                                }, onBlur: addTag, placeholder: "Type + Enter to add", className: "min-w-[100px] flex-1 border-0 p-0 text-sm outline-none" })] })] }), _jsxs("div", { className: "flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3", children: [_jsx("label", { className: "text-sm text-neutral-700", children: "Community visibility" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "button", onClick: () => update("visibility", "public"), className: `rounded-lg px-3 py-1.5 text-xs font-medium transition ${data.visibility === "public" ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`, children: "Public" }), _jsx("button", { type: "button", onClick: () => update("visibility", "private"), className: `rounded-lg px-3 py-1.5 text-xs font-medium transition ${data.visibility === "private" ? "bg-[#C2185B] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`, children: "Private" })] })] })] })) : (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "mb-1 block text-xs font-medium text-neutral-600", children: "Community rules" }), _jsx("textarea", { value: data.rules, onChange: (e) => update("rules", e.target.value), placeholder: "Any rules members should follow...", rows: 2, className: "w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20" })] }), _jsxs("div", { className: "space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/50 px-4 py-3", children: [_jsxs("label", { className: "flex items-start gap-3", children: [_jsx("input", { type: "checkbox", checked: data.agree18, onChange: (e) => update("agree18", e.target.checked), className: "mt-0.5 h-4 w-4 rounded border-neutral-300 text-[#C2185B] accent-[#C2185B]" }), _jsxs("span", { className: "text-sm text-neutral-700", children: ["I confirm that I am ", _jsx("strong", { children: "18 years or older" })] })] }), _jsxs("label", { className: "flex items-start gap-3", children: [_jsx("input", { type: "checkbox", checked: data.agreeContent, onChange: (e) => update("agreeContent", e.target.checked), className: "mt-0.5 h-4 w-4 rounded border-neutral-300 text-[#C2185B] accent-[#C2185B]" }), _jsxs("span", { className: "text-sm text-neutral-700", children: ["I agree not to post ", _jsx("strong", { children: "prohibited content" }), " including hate speech, harassment, or explicit material"] })] })] })] }));
}
//# sourceMappingURL=community-details-form.js.map