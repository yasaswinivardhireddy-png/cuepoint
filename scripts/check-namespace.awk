# Fails when a rendered manifest puts a resource outside the cuepoint namespace. kustomize only
# namespaces what each kustomization declares, so a resource added in an overlay can slip through.
#   kustomize build deploy/k8s/overlays/eks | awk -f scripts/check-namespace.awk
function check() {
  if (kind != "" && kind != "Namespace" && ns != "cuepoint") {
    print kind "/" name " is not in the cuepoint namespace"
    bad = 1
  }
  kind = ""; name = ""; ns = ""
}
FNR == 1 { check() }
/^---$/ { check() }
/^kind: / { kind = $2 }
/^  name: / { if (name == "") name = $2 }
/^  namespace: / { ns = $2 }
END { check(); exit bad }
