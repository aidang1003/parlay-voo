import { ArrowLeftIcon, ArrowRightIcon } from "@heroicons/react/24/outline";

type PaginationButtonProps = {
  currentPage: number;
  totalItems: number;
  setCurrentPage: (page: number) => void;
};

const ITEMS_PER_PAGE = 20;

export const PaginationButton = ({ currentPage, totalItems, setCurrentPage }: PaginationButtonProps) => {
  const isPrevButtonDisabled = currentPage === 0;
  const isNextButtonDisabled = currentPage + 1 >= Math.ceil(totalItems / ITEMS_PER_PAGE);

  if (isNextButtonDisabled && isPrevButtonDisabled) return null;

  const buttonBase =
    "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const buttonActive =
    "border-white/10 bg-white/5 text-gray-300 hover:border-brand-pink/40 hover:bg-brand-pink/10 hover:text-brand-pink";
  const buttonDisabled = "border-white/5 bg-white/[0.02] text-gray-600";

  return (
    <div className="mt-5 flex justify-end gap-3">
      <button
        className={`${buttonBase} ${isPrevButtonDisabled ? buttonDisabled : buttonActive}`}
        disabled={isPrevButtonDisabled}
        onClick={() => setCurrentPage(currentPage - 1)}
      >
        <ArrowLeftIcon className="h-4 w-4" />
      </button>
      <span className="self-center text-xs font-medium text-gray-400">Page {currentPage + 1}</span>
      <button
        className={`${buttonBase} ${isNextButtonDisabled ? buttonDisabled : buttonActive}`}
        disabled={isNextButtonDisabled}
        onClick={() => setCurrentPage(currentPage + 1)}
      >
        <ArrowRightIcon className="h-4 w-4" />
      </button>
    </div>
  );
};
