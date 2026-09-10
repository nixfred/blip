-- Blip's narrowly scoped Contacts UI handoff.
--
-- Contacts exposes multi-card selection to AppleScript, but no link command.
-- This helper selects exact, revalidated card ids and either reports the one
-- Apple-provided link/merge menu action or clicks it after Blip's separate
-- confirmation. It accepts only a fixed mode and card ids supplied by the
-- owner-controlled Python bridge.

on jsonError(messageText)
  set cleaned to my oneLine(messageText)
  return "{\"ok\":false,\"error\":\"" & cleaned & "\"}"
end jsonError

on oneLine(valueText)
  set sourceText to valueText as text
  set AppleScript's text item delimiters to {return, linefeed, tab, "\"", "\\"}
  set pieces to text items of sourceText
  set AppleScript's text item delimiters to " "
  set joined to pieces as text
  set AppleScript's text item delimiters to ""
  if (count joined) > 160 then set joined to text 1 thru 160 of joined
  return joined
end oneLine

on trimSpaces(valueText)
  set resultText to valueText as text
  repeat while resultText begins with " "
    if (count resultText) = 1 then return ""
    set resultText to text 2 thru -1 of resultText
  end repeat
  repeat while resultText ends with " "
    if (count resultText) = 1 then return ""
    set resultText to text 1 thru -2 of resultText
  end repeat
  return resultText
end trimSpaces

on run argv
  try
    if (count argv) < 3 or (count argv) > 10 then return my jsonError("invalid card selection")
    set operation to item 1 of argv
    if operation is not "prepare" and operation is not "link" then return my jsonError("invalid link operation")
    set firstCardIndex to 2
    set expectedAction to ""
    if operation is "link" then
      if (count argv) < 4 then return my jsonError("invalid card selection")
      set expectedAction to item 2 of argv
      if expectedAction is not "Link Selected Cards" and expectedAction is not "Merge Selected Cards" and expectedAction is not "Merge and Link Selected Cards" then return my jsonError("invalid expected link action")
      set firstCardIndex to 3
    end if

    tell application "Contacts"
      if unsaved then return my jsonError("Contacts has unsaved changes; finish or discard them first")
      set selectedCards to {}
      repeat with itemNumber from firstCardIndex to count argv
        set personId to item itemNumber of argv
        if not (exists person id personId) then return my jsonError("an exact Contacts card is unavailable")
        set end of selectedCards to person id personId
      end repeat
      set selection to selectedCards
      activate
      delay 0.4
      if (count selection) is not ((count argv) - firstCardIndex + 1) then return my jsonError("Contacts did not select every requested card")
    end tell

    tell application "System Events"
      if UI elements enabled is false then return my jsonError("Accessibility is required for linking Contacts cards")
      tell process "Contacts"
        set cardMenu to menu 1 of menu bar item "Card" of menu bar 1
        set actionItem to missing value
        set actionName to ""
        repeat with candidateItem in every menu item of cardMenu
          try
            set candidateName to my trimSpaces(name of candidateItem)
            if candidateName is "Link Selected Cards" or candidateName is "Merge Selected Cards" or candidateName is "Merge and Link Selected Cards" then
              set actionItem to candidateItem
              set actionName to candidateName
              exit repeat
            end if
          end try
        end repeat
        if actionItem is missing value then return my jsonError("Contacts does not expose a link or merge action")
        if enabled of actionItem is false then
          return "{\"ok\":true,\"ready\":false,\"action\":\"" & actionName & "\"}"
        end if
        if operation is "prepare" then
          return "{\"ok\":true,\"ready\":true,\"action\":\"" & actionName & "\"}"
        end if
        if actionName is not expectedAction then return my jsonError("Contacts link action changed; review the cards again")
        click actionItem
      end tell
    end tell
    delay 0.8
    return "{\"ok\":true,\"linked\":true,\"action\":\"" & actionName & "\"}"
  on error messageText
    return my jsonError(messageText)
  end try
end run
