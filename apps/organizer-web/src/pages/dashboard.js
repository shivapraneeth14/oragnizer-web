import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { useAuth } from "../auth-context";
import { supabase } from "../supabase";
import ProfileSection from "../components/profile/profile-section";
import EventList from "../components/events/event-list";
import EventForm from "../components/events/event-form";
import EventDetail from "../components/events/event-detail";
import MediaSection from "../components/media/media-section";
import PayoutSection from "../components/payout/payout-section";
import MemberRow from "../components/members/member-row";
import { useEvents, eventToForm } from "../hooks/use-events";
import CommunityDetailsForm, { initialCommunityData } from "../components/community-details-form";
const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
    { id: "events", label: "Events", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
    { id: "members", label: "Members", icon: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" },
    { id: "media", label: "Media", icon: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" },
    { id: "payout", label: "Payout", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
    { id: "settings", label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" },
    { id: "profile", label: "Profile", icon: "M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
];
export default function DashboardPage() {
    const { user, signOut, loading, clearMessages } = useAuth();
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
    const [activeSection, setActiveSection] = useState("dashboard");
    const [profileOpen, setProfileOpen] = useState(false);
    const [communityId, setCommunityId] = useState();
    const [community, setCommunity] = useState(null);
    const [upcomingCount, setUpcomingCount] = useState(0);
    const [showForm, setShowForm] = useState(false);
    const [editingEvent, setEditingEvent] = useState(null);
    const [viewingEvent, setViewingEvent] = useState(null);
    const [members, setMembers] = useState([]);
    const [membersLoading, setMembersLoading] = useState(false);
    const [formSaving, setFormSaving] = useState(false);
    const [formError, setFormError] = useState(null);
    const [inviteCopied, setInviteCopied] = useState(false);
    const [showShareOptions, setShowShareOptions] = useState(false);
    const [memberRefreshKey, setMemberRefreshKey] = useState(0);
    const [needsCommunity, setNeedsCommunity] = useState(false);
    const [communityData, setCommunityData] = useState(initialCommunityData);
    const [communityStep, setCommunityStep] = useState(1);
    const [communityCreating, setCommunityCreating] = useState(false);
    const [communityError, setCommunityError] = useState(null);
    const [upcomingError, setUpcomingError] = useState(null);
    const [membersError, setMembersError] = useState(null);
    useEffect(() => {
        const onResize = () => setSidebarOpen(window.innerWidth >= 1024);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    const { events, loading: eventsLoading, loadingMore: eventsLoadingMore, hasMore: eventsHasMore, error: eventsError, refresh: refreshEvents, createEvent, updateEvent, cancelEvent, fetchNextPage } = useEvents(communityId);
    useEffect(() => {
        if (!user)
            return;
        setCommunityError(null);
        supabase.from("communities").select("id, name, member_count").eq("owner_id", user.id).maybeSingle().then(({ data, error }) => {
            if (error) {
                setCommunityError(error.message);
            }
            else if (data) {
                setCommunityId(data.id);
                setCommunity(data);
            }
            else {
                setNeedsCommunity(true);
            }
        });
    }, [user]);
    useEffect(() => {
        if (!communityId)
            return;
        setUpcomingError(null);
        supabase
            .from("events")
            .select("id", { count: "exact", head: true })
            .eq("community_id", communityId)
            .gte("start_date", new Date().toISOString())
            .neq("status", "cancelled")
            .is("deleted_at", null)
            .then(({ count, error }) => {
            if (error) {
                setUpcomingError(error.message);
            }
            else {
                setUpcomingCount(count || 0);
            }
        });
    }, [communityId]);
    useEffect(() => {
        if (!communityId || activeSection !== "members")
            return;
        setMembersLoading(true);
        setMembersError(null);
        supabase
            .from("community_members")
            .select("user_id, role, joined_at, profiles(email, username, first_name, last_name)")
            .eq("community_id", communityId)
            .order("joined_at", { ascending: false })
            .range(0, 49)
            .then(({ data, error }) => {
            if (error) {
                setMembersError(error.message);
            }
            else if (data) {
                setMembers(data.map((m) => ({
                    user_id: m.user_id,
                    role: m.role,
                    joined_at: m.joined_at,
                    email: m.profiles?.email || null,
                    username: m.profiles?.username || null,
                    first_name: m.profiles?.first_name || null,
                    last_name: m.profiles?.last_name || null,
                })));
            }
            setMembersLoading(false);
        });
    }, [communityId, activeSection, memberRefreshKey]);
    const handleFormSave = async (data) => {
        if (!user)
            return;
        setFormSaving(true);
        setFormError(null);
        const err = editingEvent
            ? await updateEvent(editingEvent.id, data)
            : await createEvent(data, user.id);
        if (err) {
            setFormError(err);
        }
        else {
            setShowForm(false);
            setEditingEvent(null);
        }
        setFormSaving(false);
    };
    const handleEdit = (event) => {
        setEditingEvent(event);
        setShowForm(true);
    };
    const handleCancelEvent = async (id) => {
        await cancelEvent(id);
    };
    const handleViewDetail = (event) => {
        setViewingEvent(event);
    };
    const handleDetailEdit = () => {
        if (!viewingEvent)
            return;
        setEditingEvent(viewingEvent);
        setViewingEvent(null);
        setShowForm(true);
    };
    const handleDetailCancel = async () => {
        if (!viewingEvent)
            return;
        await cancelEvent(viewingEvent.id);
        setViewingEvent(null);
    };
    const handleCreateCommunity = async () => {
        if (!user)
            return;
        setCommunityCreating(true);
        try {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            if (!token)
                return;
            const { supabaseFetch } = await import("../supabase-fetch");
            const res = await supabaseFetch("/functions/v1/create-community", token, { ...communityData, community_name: communityData.community_name.trim() });
            const result = await res.json();
            if (!res.ok) {
                alert(result.error || "Failed to create community");
                return;
            }
            setCommunityId(result.community_id);
            setCommunity({ id: result.community_id, name: communityData.community_name, member_count: 1 });
            setNeedsCommunity(false);
            setCommunityData(initialCommunityData);
            setCommunityStep(1);
        }
        catch {
            alert("Something went wrong");
        }
        setCommunityCreating(false);
    };
    if (needsCommunity) {
        return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-neutral-50 p-8", children: _jsx("div", { className: "w-full max-w-lg", children: _jsxs("div", { className: "rounded-xl border border-neutral-200 bg-white p-8 shadow-soft", children: [_jsx("h2", { className: "text-xl font-semibold text-neutral-900", children: "Create Your Community" }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Welcome! Set up your community to get started." }), _jsx("div", { className: "mt-6", children: _jsx(CommunityDetailsForm, { data: communityData, onChange: setCommunityData, checkName: async (name) => {
                                    try {
                                        const { supabaseFetchNoAuth } = await import("../supabase-fetch");
                                        const res = await supabaseFetchNoAuth("/functions/v1/check-community-name", { name });
                                        return (await res.json()).available === true;
                                    }
                                    catch {
                                        return true;
                                    }
                                }, step: communityStep }) }), _jsxs("div", { className: "mt-6 flex items-center justify-between", children: [communityStep === 2 && (_jsx("button", { type: "button", onClick: () => setCommunityStep(1), className: "text-sm text-neutral-500 hover:text-neutral-700", children: "\u2190 Back" })), _jsx("div", { className: "flex-1" }), communityStep === 1 ? (_jsx("button", { onClick: () => {
                                        if (!communityData.community_name.trim()) {
                                            alert("Community name is required");
                                            return;
                                        }
                                        setCommunityStep(2);
                                    }, className: "rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A]", children: "Next" })) : (_jsx("button", { onClick: handleCreateCommunity, disabled: communityCreating, className: "rounded-lg bg-[#C2185B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#A0154A] disabled:opacity-50", children: communityCreating ? "Creating..." : "Create Community" }))] })] }) }) }));
    }
    return (_jsxs("div", { className: "flex h-screen bg-neutral-50", children: [sidebarOpen && (_jsx("div", { className: "fixed inset-0 z-20 bg-black/30 lg:hidden", onClick: () => setSidebarOpen(false) })), _jsxs("aside", { className: `fixed left-0 top-0 z-30 flex h-full flex-col bg-white shadow-lg transition-all duration-300 ease-in-out ${sidebarOpen ? "w-64" : "w-0 -translate-x-full lg:w-16 lg:translate-x-0"}`, children: [_jsxs("div", { className: "flex h-16 items-center justify-between border-b border-neutral-200 px-4", children: [sidebarOpen && (_jsx("span", { className: "text-lg font-bold tracking-wider text-[#C2185B]", children: "CLUVO" })), _jsx("button", { onClick: () => setSidebarOpen(!sidebarOpen), className: "rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700", children: _jsx("svg", { className: `h-5 w-5 transition-transform ${sidebarOpen ? "" : "rotate-180"}`, fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M11 19l-7-7 7-7m8 14l-7-7 7-7" }) }) })] }), _jsx("nav", { className: "flex-1 space-y-1 overflow-y-auto px-3 py-4", children: navItems.map((item) => (_jsxs("button", { onClick: () => {
                                setActiveSection(item.id);
                                if (window.innerWidth < 1024)
                                    setSidebarOpen(false);
                            }, className: `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${activeSection === item.id
                                ? "bg-[#C2185B]/10 text-[#C2185B]"
                                : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800"}`, children: [_jsx("svg", { className: "h-5 w-5 shrink-0", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 1.5, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: item.icon }) }), sidebarOpen && _jsx("span", { children: item.label })] }, item.id))) }), _jsxs("div", { className: "border-t border-neutral-200 px-3 py-3", children: [sidebarOpen && (_jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setProfileOpen(!profileOpen), className: "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100", children: [_jsx("div", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-[#C2185B]/20 text-xs font-bold text-[#C2185B]", children: user?.email?.charAt(0).toUpperCase() || "U" }), _jsxs("div", { className: "flex-1 truncate text-left", children: [_jsx("p", { className: "text-xs font-medium text-neutral-700", children: user?.email }), _jsx("p", { className: "text-xs text-neutral-400", children: "Organizer" })] })] }), profileOpen && (_jsx("div", { className: "absolute bottom-full left-0 mb-2 w-full rounded-lg border border-neutral-200 bg-white shadow-lg", children: _jsxs("button", { onClick: () => { signOut(); setProfileOpen(false); }, className: "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50", children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" }) }), "Sign Out"] }) }))] })), !sidebarOpen && (_jsx("button", { onClick: () => setSidebarOpen(true), className: "flex w-full items-center justify-center rounded-lg px-3 py-2 text-neutral-500 hover:bg-neutral-100", title: "Expand sidebar", children: _jsx("svg", { className: "h-5 w-5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M13 5l7 7-7 7M5 5l7 7-7 7" }) }) }))] })] }), _jsxs("main", { className: `flex-1 transition-all duration-300 ${sidebarOpen ? "lg:pl-64" : "lg:pl-16"} pl-0`, children: [_jsxs("header", { className: "flex h-16 items-center justify-between border-b border-neutral-200 bg-white px-6", children: [_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("button", { onClick: () => setSidebarOpen(!sidebarOpen), className: "rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 lg:hidden", children: _jsx("svg", { className: "h-5 w-5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M4 6h16M4 12h16M4 18h16" }) }) }), _jsx("h2", { className: "text-lg font-semibold text-neutral-900 capitalize", children: activeSection })] }), _jsx("div", { className: "flex items-center gap-3", children: _jsx("div", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-[#C2185B]/20 text-xs font-bold text-[#C2185B]", children: user?.email?.charAt(0).toUpperCase() || "U" }) })] }), _jsxs("div", { className: "overflow-y-auto p-6", children: [activeSection === "dashboard" && (_jsxs("div", { children: [_jsx("h3", { className: "text-xl font-semibold text-neutral-900", children: "Welcome to Cluvo" }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Your community dashboard is ready. Start managing your events, members, and settings from here." }), _jsxs("div", { className: "mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-neutral-200 bg-white p-5 shadow-soft", children: [_jsx("p", { className: "text-sm text-neutral-500", children: "Total Members" }), communityError ? (_jsx("p", { className: "mt-1 text-sm text-red-500", children: communityError })) : (_jsx("p", { className: "mt-1 text-3xl font-bold text-neutral-900", children: community?.member_count ?? 0 }))] }), _jsxs("div", { className: "rounded-xl border border-neutral-200 bg-white p-5 shadow-soft", children: [_jsx("p", { className: "text-sm text-neutral-500", children: "Upcoming Events" }), upcomingError ? (_jsx("p", { className: "mt-1 text-sm text-red-500", children: upcomingError })) : (_jsx("p", { className: "mt-1 text-3xl font-bold text-neutral-900", children: upcomingCount }))] }), _jsxs("div", { className: "rounded-xl border border-neutral-200 bg-white p-5 shadow-soft", children: [_jsx("p", { className: "text-sm text-neutral-500", children: "Total Events" }), eventsError ? (_jsx("p", { className: "mt-1 text-sm text-red-500", children: eventsError })) : (_jsx("p", { className: "mt-1 text-3xl font-bold text-neutral-900", children: events.length }))] })] })] })), activeSection === "events" && (viewingEvent ? (_jsx(EventDetail, { event: viewingEvent, onEdit: handleDetailEdit, onCancel: handleDetailCancel, onClose: () => setViewingEvent(null) })) : (_jsx(EventList, { events: events, loading: eventsLoading, loadingMore: eventsLoadingMore, hasMore: eventsHasMore, error: eventsError, onLoadMore: fetchNextPage, onRetry: refreshEvents, onView: handleViewDetail, onEdit: handleEdit, onCancel: handleCancelEvent, onCreate: () => { setEditingEvent(null); setShowForm(true); } }))), activeSection === "members" && (_jsxs("div", { children: [_jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { children: [_jsxs("h3", { className: "text-xl font-semibold text-neutral-900", children: ["Members (", members.length, ")"] }), _jsx("p", { className: "mt-2 text-sm text-neutral-500", children: "Users who follow your community." })] }), _jsxs("div", { className: "relative", children: [_jsx("button", { onClick: async () => {
                                                            if (!communityId)
                                                                return;
                                                            const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                                                            const url = `${base}communities/${communityId}`;
                                                            const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
                                                            if (navigator.share && isMobile) {
                                                                try {
                                                                    await navigator.share({ title: 'Join my community on Cluvo', url });
                                                                }
                                                                catch {
                                                                    // user cancelled — do nothing
                                                                }
                                                            }
                                                            else {
                                                                setShowShareOptions(!showShareOptions);
                                                            }
                                                        }, className: `flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${inviteCopied ? 'bg-green-600' : 'bg-[#C2185B] hover:bg-[#A0154A]'}`, children: inviteCopied ? (_jsxs(_Fragment, { children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M5 13l4 4L19 7" }) }), "Copied!"] })) : (_jsxs(_Fragment, { children: [_jsx("svg", { className: "h-4 w-4", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" }) }), "Invite"] })) }), showShareOptions && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-40", onClick: () => setShowShareOptions(false) }), _jsx("div", { className: "absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-neutral-200 bg-white shadow-lg", children: _jsxs("div", { className: "p-1.5", children: [_jsxs("button", { onClick: () => {
                                                                                if (!communityId)
                                                                                    return;
                                                                                const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                                                                                const url = encodeURIComponent(`${base}communities/${communityId}`);
                                                                                window.open(`https://wa.me/?text=${url}`, '_blank');
                                                                                setShowShareOptions(false);
                                                                            }, className: "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100", children: [_jsx("svg", { className: "h-5 w-5 text-green-500", fill: "currentColor", viewBox: "0 0 24 24", children: _jsx("path", { d: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" }) }), "WhatsApp"] }), _jsxs("button", { onClick: () => {
                                                                                if (!communityId)
                                                                                    return;
                                                                                const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                                                                                const url = encodeURIComponent(`${base}communities/${communityId}`);
                                                                                window.location.href = `mailto:?subject=${encodeURIComponent('Join my community on Cluvo')}&body=${url}`;
                                                                                setShowShareOptions(false);
                                                                            }, className: "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100", children: [_jsx("svg", { className: "h-5 w-5 text-blue-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" }) }), "Email"] }), _jsxs("button", { onClick: async () => {
                                                                                if (!communityId)
                                                                                    return;
                                                                                const base = import.meta.env.VITE_APP_DEEPLINK_BASE || 'cluvo://';
                                                                                await navigator.clipboard.writeText(`${base}communities/${communityId}`);
                                                                                setInviteCopied(true);
                                                                                setShowShareOptions(false);
                                                                                setTimeout(() => setInviteCopied(false), 2000);
                                                                            }, className: "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-100", children: [_jsx("svg", { className: "h-5 w-5 text-neutral-500", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", strokeWidth: 2, children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" }) }), "Copy Link"] })] }) })] }))] })] }), membersLoading ? (_jsx("div", { className: "flex items-center justify-center py-20", children: _jsxs("svg", { className: "h-8 w-8 animate-spin text-[#C2185B]", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) })) : membersError ? (_jsxs("div", { className: "mt-6 rounded-xl border border-red-200 bg-red-50 p-8 text-center", children: [_jsx("p", { className: "text-sm text-red-600", children: membersError }), _jsx("button", { onClick: () => setMemberRefreshKey((k) => k + 1), className: "mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700", children: "Retry" })] })) : members.length === 0 ? (_jsx("div", { className: "mt-6 rounded-xl border border-neutral-200 bg-white p-8 text-center", children: _jsx("p", { className: "text-sm text-neutral-500", children: "No members yet." }) })) : (_jsx("div", { className: "mt-6 overflow-x-auto rounded-xl border border-neutral-200 bg-white", children: _jsxs("table", { className: "w-full text-left text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-neutral-200 bg-neutral-50", children: [_jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Username" }), _jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Role" }), _jsx("th", { className: "px-4 py-3 font-medium text-neutral-600", children: "Joined" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: members.map((m) => (_jsx(MemberRow, { member: m, currentUserId: user.id, communityId: communityId, onRemoved: () => setMemberRefreshKey((k) => k + 1) }, m.user_id))) })] }) }))] })), activeSection === "media" && (_jsx(MediaSection, { communityId: communityId })), activeSection === "payout" && (_jsx(PayoutSection, { communityId: communityId })), activeSection === "settings" && (_jsx("p", { className: "text-neutral-500", children: "Settings section \u2014 coming soon." })), activeSection === "profile" && _jsx(ProfileSection, {})] })] }), showForm && (_jsx(EventForm, { initial: editingEvent ? eventToForm(editingEvent) : undefined, saving: formSaving, onSave: handleFormSave, onClose: () => { setShowForm(false); setEditingEvent(null); setFormError(null); } })), formError && (_jsx("div", { className: "fixed bottom-4 right-4 z-50 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600 shadow-lg", children: formError }))] }));
}
//# sourceMappingURL=dashboard.js.map