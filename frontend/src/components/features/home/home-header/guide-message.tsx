export function GuideMessage() {
  return (
    <div
      className="w-fit flex flex-col md:flex-row items-start md:items-center justify-center gap-1 rounded-[12px] bg-[rgba(139,92,246,0.10)] border border-[rgba(139,92,246,0.28)] leading-5 text-white text-[15px] font-normal m-1 md:h-9.5 px-4 pb-1 md:px-[15px] md:py-0"
    >
      <span>Welcome to Nimbus Chat. New here?</span>
      <a
        href="https://docs.nimbusapi.net"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#22D3EE] hover:text-white transition-colors"
      >
        <span className="underline">Read the docs</span>
      </a>
    </div>
  );
}
