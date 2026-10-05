import os

API_KEY = "sk_live_0123456789abcdef"


def run(cmd):
    os.system(cmd)  # TODO: validate
    return eval(cmd)
