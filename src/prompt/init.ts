// Shell glue printed by `rooms prompt init <shell>`, in the style of starship
// and zoxide: the user adds one line to their shell config. zsh and fish
// refresh in the background and repaint, so the prompt never waits; bash has
// no repaint hook, so it reads synchronously. Every refresh carries the folder
// it ran for, and a result for a folder the shell has left is dropped.

export const PROMPT_SHELLS = ["zsh", "bash", "fish"] as const;
export type PromptShell = typeof PROMPT_SHELLS[number];

/** `command` is the shell words that run `rooms prompt`, already quoted. */
export function promptInitScript(shell: PromptShell, command: string): string {
  if (shell === "zsh") return zshScript(command);
  if (shell === "bash") return bashScript(command);
  return fishScript(command);
}

/** Single-quotes a word for POSIX shells and fish. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function zshScript(command: string): string {
  return `# shrooms room prompt for zsh. Show it with, for example:
#   setopt prompt_subst; RPROMPT='$ROOMS_PROMPT'
typeset -g ROOMS_PROMPT=""
typeset -g _rooms_prompt_fd=0
typeset -g _rooms_prompt_pwd=""
_rooms_prompt_done() {
  local fd=$1 line="" tab=$'\\t'
  IFS= read -r -u $fd line
  zle -F $fd
  exec {fd}<&-
  (( fd == _rooms_prompt_fd )) && _rooms_prompt_fd=0
  [[ "\${line%%$tab*}" == "$PWD" ]] || return 0
  line=\${line#*$tab}
  if [[ "$line" != "$ROOMS_PROMPT" ]]; then
    ROOMS_PROMPT=$line
    zle && zle reset-prompt
  fi
}
_rooms_prompt_precmd() {
  if (( _rooms_prompt_fd )); then
    zle -F $_rooms_prompt_fd 2>/dev/null
    exec {_rooms_prompt_fd}<&-
    _rooms_prompt_fd=0
  fi
  [[ "$_rooms_prompt_pwd" == "$PWD" ]] || ROOMS_PROMPT=""
  _rooms_prompt_pwd=$PWD
  exec {_rooms_prompt_fd}< <(print -r -- "$PWD"$'\\t'"$(${command} 2>/dev/null)")
  zle -F $_rooms_prompt_fd _rooms_prompt_done
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rooms_prompt_precmd
`;
}

function bashScript(command: string): string {
  return `# shrooms room prompt for bash. Show it with, for example:
#   PS1='\\w \${ROOMS_PROMPT:+[$ROOMS_PROMPT] }\\$ '
ROOMS_PROMPT=""
_rooms_prompt() { ROOMS_PROMPT="$(${command} 2>/dev/null)"; }
case ";\${PROMPT_COMMAND:-};" in
  *";_rooms_prompt;"*) ;;
  *) PROMPT_COMMAND="_rooms_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
`;
}

function fishScript(command: string): string {
  // The refresh runs detached under sh, so fish keeps no background job (and
  // prints no job notices); it writes "<folder>\t<segment>" to a file and
  // signals this shell, which repaints when the folder still matches.
  return `# shrooms room prompt for fish. Show it from your prompt, for example:
#   function fish_right_prompt; rooms_prompt; end
set -g __rooms_prompt_value ""
set -g __rooms_prompt_pwd ""
set -g __rooms_prompt_file (string trim -r -c / -- (set -q TMPDIR; and echo $TMPDIR; or echo /tmp))/rooms-prompt-$fish_pid
function __rooms_prompt_refresh --on-event fish_prompt
    if test "$__rooms_prompt_pwd" != "$PWD"
        set -g __rooms_prompt_value ""
        set -g __rooms_prompt_pwd $PWD
    end
    command sh -c '( out=$(eval "$4" 2>/dev/null); printf "%s\\t%s" "$1" "$out" >"$2.tmp" && mv "$2.tmp" "$2" && kill -USR1 "$3" ) >/dev/null 2>&1 </dev/null &' sh $PWD $__rooms_prompt_file $fish_pid ${fishQuote(command)}
end
function __rooms_prompt_signal --on-signal SIGUSR1
    test -r $__rooms_prompt_file; or return 0
    read -l -z line <$__rooms_prompt_file
    set -l parts (string split -m 1 \\t -- $line)
    test "$parts[1]" = "$PWD"; or return 0
    if test "$parts[2]" != "$__rooms_prompt_value"
        set -g __rooms_prompt_value $parts[2]
        commandline -f repaint
    end
end
function __rooms_prompt_exit --on-event fish_exit
    command rm -f $__rooms_prompt_file $__rooms_prompt_file.tmp
end
function rooms_prompt --description "The shrooms room for this folder"
    echo -n $__rooms_prompt_value
end
`;
}

/** Single-quotes a word for fish, whose quotes escape only \\ and '. */
function fishQuote(word: string): string {
  return `'${word.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
