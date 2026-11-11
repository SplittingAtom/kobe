---
title: Notebooks and Python
summary: How to run Jupyter notebooks and Python files in your sandbox, control the kernel, and read the output.
section: Files and editing
order: 3
audience: member
---

Kobe runs Jupyter notebooks (`.ipynb`) and Python files (`.py`) in your own sandbox. Each
conversation has one live Python kernel that you and the agent share, so variables and imports
carry from one run to the next. Code never runs on the server or in your browser.

## Before you start

Code runs in a conversation's kernel. Open the notebook or `.py` file while a conversation is on
screen; in a new conversation, send a message first ("Send a message first: code runs in this
conversation's kernel, in your sandbox."). Only the conversation's owner can run code.

The sandbox comes with Python 3.12 and a data stack including pandas, NumPy, DuckDB, PyArrow,
Matplotlib, openpyxl, python-docx, ReportLab and pypdf. Installing more packages needs internet
access to the package index, which your team admins decide (see
[Internet access](../internet-and-approvals/internet-access.md)).

## The kernel

The toolbar shows the kernel's state: "No kernel", "Waking sandbox…", "Starting kernel…", "Kernel
idle" or "Kernel busy".

- **Start** starts a kernel (and wakes a sleeping sandbox). Running code starts one too.
- **Interrupt** stops the code that is running; the kernel and its variables stay.
- **Restart** asks first ("Restart the kernel? Its variables and imports are lost.") and gives you
  a fresh kernel.

The kernel stops after 30 idle minutes and when your sandbox goes to sleep. One run happens at a
time: while the agent is answering in the conversation, your run waits its turn.

## Notebooks

A notebook opens as cells. **Run cell N** runs one cell; **Run all** runs the code cells in order
and stops at the first error. Cells can be edited (**Edit cell N**, then **Done**), moved, deleted,
and added (Add code cell, or a Markdown cell below). **Save** writes the notebook; outputs are saved
into it.

Outputs show text, errors with their traceback, pandas tables, images (Matplotlib plots appear
inline) and HTML. HTML and SVG output is shown in a locked-down frame with no network access.

## Python files

A `.py` file shows **Run** in the editor toolbar. Run uses the saved file, so save your changes
first. Running splits the editor: code on top, the live output below. Drag the divider (or use Up,
Down, Page Up, Page Down, Home and End; Enter goes back to half and half); this browser remembers
the split. The output stays after the run, can be collapsed to its bar or closed, and opens again
on the next run, including when the agent runs the file.

## The agent runs code too

The agent runs Python with its `run_python` tool in the same kernel: it can pick up a DataFrame you
loaded, and you can inspect what it computed. `run_python` follows your team's tool rules like the
shell does, so it may ask for approval. When the agent changes a notebook, it proposes the edit for
your review like any other file (see [Editing files](file-editor.md)).

## Troubleshooting

- **"Save your changes first: Run uses the saved file."** Save, then Run.
- **The kernel lost my variables.** It restarted, went idle for 30 minutes, or the sandbox slept.
  Run the setup cells again.
- **A package is missing.** Ask the agent to install it with pip; if the download is blocked, use
  **Request access** on the blocked card.
