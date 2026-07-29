interface Props {
  onChoice: (hasAccount: boolean) => void
}

export default function AccountChoice({ onChoice }: Props) {
  return (
    <div className="flex flex-col items-center py-8">
      <h2 className="text-xl font-semibold text-neutral-900">Create Community</h2>
      <p className="mt-2 text-sm text-neutral-500 text-center max-w-xs">
        Do you already have a Cluvo account?
      </p>

      <div className="mt-8 flex w-full flex-col gap-3">
        <button
          type="button"
          onClick={() => onChoice(true)}
          className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 px-5 py-4 text-left transition hover:border-[#C2185B]/30 hover:bg-[#C2185B]/5"
        >
          <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-neutral-300">
            <div className="h-2.5 w-2.5 rounded-full" />
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-900">Yes, I already have an account</p>
            <p className="text-xs text-neutral-400">Sign in and create a community</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onChoice(false)}
          className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 px-5 py-4 text-left transition hover:border-[#C2185B]/30 hover:bg-[#C2185B]/5"
        >
          <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-neutral-300">
            <div className="h-2.5 w-2.5 rounded-full" />
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-900">No, I'm new to Cluvo</p>
            <p className="text-xs text-neutral-400">Create an account and a community</p>
          </div>
        </button>
      </div>
    </div>
  )
}
