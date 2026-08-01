import { useState, useCallback, useRef, useEffect } from "react"
import PhoneInput from "react-phone-number-input"
import "react-phone-number-input/style.css"
import { Country, State, City } from "country-state-city"
import DropdownSelect from "./dropdown-select"

const categories = [
  "Technology", "Sports & Fitness", "Music & Arts",
  "Education", "Health & Wellness", "Food & Drink",
  "Business & Finance", "Social & Community", "Travel & Outdoors",
  "Gaming", "Photography", "Other",
]

export interface CommunityData {
  community_name: string
  category: string
  description: string
  city: string
  state: string
  country: string
  contact_email: string
  contact_phone: string
  tags: string[]
  visibility: "public" | "private"
  rules: string
  agree18: boolean
  agreeContent: boolean
}

export const initialCommunityData: CommunityData = {
  community_name: "", category: "", description: "",
  city: "", state: "", country: "",
  contact_email: "", contact_phone: "",
  tags: [], visibility: "public", rules: "",
  agree18: false, agreeContent: false,
}

export function missingCommunityFields(data: CommunityData): { step1: string[]; step2: string[] } {
  const step1: string[] = []
  if (!data.community_name.trim()) step1.push("Community name")
  if (!data.category.trim()) step1.push("Category")
  if (!data.country) step1.push("Country")
  if (!data.state) step1.push("State")
  if (!data.city) step1.push("City")
  if (!data.contact_email.trim()) step1.push("Contact email")
  if (!data.contact_phone.trim()) step1.push("Contact phone")
  const step2: string[] = []
  if (!data.rules.trim()) step2.push("Community rules")
  if (!data.agree18) step2.push("18+ confirmation")
  if (!data.agreeContent) step2.push("Content guidelines agreement")
  return { step1, step2 }
}

interface Props {
  data: CommunityData
  onChange: (data: CommunityData) => void
  checkName: (name: string) => Promise<boolean>
  checkEmail: (email: string) => Promise<boolean>
  step: 1 | 2
}

export default function CommunityDetailsForm({ data, onChange, checkName, checkEmail, step }: Props) {
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null)
  const [checkingName, setCheckingName] = useState(false)
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null)
  const [checkingEmail, setCheckingEmail] = useState(false)
  const [tagInput, setTagInput] = useState("")
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emailTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const update = useCallback(<K extends keyof CommunityData>(key: K, value: CommunityData[K]) => {
    onChange({ ...data, [key]: value })
  }, [data, onChange])

  const countries = Country.getAllCountries()
  const countryCode = data.country
  const states = countryCode ? State.getStatesOfCountry(countryCode) : []
  const cities = countryCode && data.state ? City.getCitiesOfState(countryCode, data.state) : []

  useEffect(() => {
    if (nameTimer.current) clearTimeout(nameTimer.current)
    const n = data.community_name.trim()
    if (n.length < 2) { setNameAvailable(null); setCheckingName(false); return }
    setCheckingName(true)
    nameTimer.current = setTimeout(async () => {
      try {
        const avail = await checkName(n)
        setNameAvailable(avail)
      } catch {
        setNameAvailable(false)
      } finally {
        setCheckingName(false)
      }
    }, 500)
    return () => { if (nameTimer.current) clearTimeout(nameTimer.current) }
  }, [data.community_name, checkName])

  useEffect(() => {
    if (emailTimer.current) clearTimeout(emailTimer.current)
    const e = data.contact_email.trim()
    if (e.length < 5 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setEmailAvailable(null); setCheckingEmail(false); return }
    setCheckingEmail(true)
    emailTimer.current = setTimeout(async () => {
      try {
        const avail = await checkEmail(e)
        setEmailAvailable(avail)
      } catch {
        setEmailAvailable(false)
      } finally {
        setCheckingEmail(false)
      }
    }, 500)
    return () => { if (emailTimer.current) clearTimeout(emailTimer.current) }
  }, [data.contact_email, checkEmail])

  const addTag = () => {
    const t = tagInput.trim().toLowerCase()
    if (t && !data.tags.includes(t)) {
      update("tags", [...data.tags, t])
    }
    setTagInput("")
  }

  const removeTag = (tag: string) => {
    update("tags", data.tags.filter((t) => t !== tag))
  }

  return step === 1 ? (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600">Community name *</label>
        <div className="relative">
          <input
            value={data.community_name}
            onChange={(e) => update("community_name", e.target.value)}
            placeholder="My Awesome Community"
            className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            {checkingName ? (
              <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : nameAvailable === true ? (
              <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : nameAvailable === false ? (
              <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : null}
          </span>
        </div>
        {nameAvailable === false && (
          <p className="mt-0.5 text-xs text-red-500">This name is already taken</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600">Category</label>
        <DropdownSelect
          value={data.category}
          onChange={(v) => update("category", v)}
          options={categories.map((c) => ({ value: c, label: c }))}
          placeholder="Select or type a category"
          freeInput
          emptyText="No matching category"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600">Description</label>
        <textarea
          value={data.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder="Tell people what your community is about..."
          rows={2}
          className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Country</label>
          <DropdownSelect
            value={data.country}
            onChange={(v) => onChange({ ...data, country: v, state: "", city: "" })}
            options={countries.map((c) => ({ value: c.isoCode, label: c.name }))}
            placeholder="Country"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">State</label>
          <DropdownSelect
            value={data.state}
            onChange={(v) => onChange({ ...data, state: v, city: "" })}
            options={states.map((s) => ({ value: s.isoCode, label: s.name }))}
            placeholder="State"
            disabled={!data.country}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">City</label>
          <DropdownSelect
            value={data.city}
            onChange={(v) => update("city", v)}
            options={cities.map((c) => ({ value: c.name, label: c.name }))}
            placeholder="City"
            disabled={!data.state}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Contact email</label>
          <div className="relative">
            <input
              type="email"
              value={data.contact_email}
              onChange={(e) => update("contact_email", e.target.value)}
              placeholder="community@example.com"
              className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 pr-8 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {checkingEmail ? (
                <svg className="h-4 w-4 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : emailAvailable === true ? (
                <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : emailAvailable === false ? (
                <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : null}
            </span>
          </div>
          {emailAvailable === false && (
            <p className="mt-0.5 text-xs text-red-500">This email is already associated with another community</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600">Contact phone</label>
          <PhoneInput
            value={data.contact_phone}
            onChange={(v) => update("contact_phone", v || "")}
            defaultCountry="IN"
            className="w-full rounded-lg border border-neutral-300 px-3.5 py-2 text-sm [&_.PhoneInputInput]:border-0 [&_.PhoneInputInput]:outline-none [&_.PhoneInputCountrySelect]:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600">Tags</label>
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-neutral-300 px-3.5 py-2">
          {data.tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full bg-[#C2185B]/10 px-2.5 py-0.5 text-xs font-medium text-[#C2185B]"
            >
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="hover:text-[#A0154A]">&times;</button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addTag() }
            }}
            onBlur={addTag}
            placeholder="Type + Enter to add"
            className="min-w-[100px] flex-1 border-0 p-0 text-sm outline-none"
          />
        </div>
      </div>


    </div>
  ) : (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600">Community rules</label>
        <textarea
          value={data.rules}
          onChange={(e) => update("rules", e.target.value)}
          placeholder="Any rules members should follow..."
          rows={2}
          className="w-full resize-none rounded-lg border border-neutral-300 px-3.5 py-2 text-sm outline-none transition focus:border-[#C2185B] focus:ring-1 focus:ring-[#C2185B]/20"
        />
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/50 px-4 py-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={data.agree18}
            onChange={(e) => update("agree18", e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-[#C2185B] accent-[#C2185B]"
          />
          <span className="text-sm text-neutral-700">
            I confirm that I am <strong>18 years or older</strong>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={data.agreeContent}
            onChange={(e) => update("agreeContent", e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-[#C2185B] accent-[#C2185B]"
          />
          <span className="text-sm text-neutral-700">
            I agree not to post <strong>prohibited content</strong> including hate speech, harassment, or explicit material
          </span>
        </label>
      </div>
    </div>
  )
}
