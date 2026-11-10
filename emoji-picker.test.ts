import {test,expect} from "bun:test";
import {searchReactionEmoji,validReactionEmoji} from "./emoji-picker";
test("search names, categories and exact multi-codepoint sequences",()=>{
 expect(searchReactionEmoji("rocket").map(x=>x.emoji)).toContain("🚀");
 expect(searchReactionEmoji("rocket","Food & Drink")).toEqual([]);
 expect(searchReactionEmoji("👩🏽‍🚀")[0]!.emoji).toBe("👩🏽‍🚀");
 for(const x of ["hello","a; rm -rf", "", "🚀hello"]) expect(validReactionEmoji(x)).toBe(false);
});
