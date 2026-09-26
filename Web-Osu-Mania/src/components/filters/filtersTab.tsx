import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "../ui/button";
import SearchFilter from "./queryFilter";
import DifficultyFilter from "./starsFilter";

const FiltersTab = () => {
  return (
    <>
      <div className="flex flex-col gap-4">
        <SearchFilter />
        <DifficultyFilter />

        <Button variant={"destructive"} className="mt-4 w-full" asChild>
          <Link
            to={"/"}
            onClick={() => {
              toast("Filters have been reset.");
            }}
          >
            Reset Filters
          </Link>
        </Button>
      </div>
    </>
  );
};

export default FiltersTab;
