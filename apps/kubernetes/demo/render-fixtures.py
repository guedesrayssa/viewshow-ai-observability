"""Renderiza fixtures e credenciais locais como Kubernetes List JSON em stdout.

Sem parâmetros. Usa arquivos versionados relativos ao script e não lê credenciais
AWS. O JSON deve ser aplicado somente ao cluster descartável da demonstração.
"""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[3]
demo=root/'apps/fullstack/demo'
files={name:(demo/'fixtures'/name).read_text() for name in ['model.json','scopes.json']}
files['seed_outbox.py']=(demo/'seed_outbox.py').read_text()
print(json.dumps({'apiVersion':'v1','kind':'List','items':[
 {'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'demo-fixtures','namespace':'view-show'},'data':files},
 {'apiVersion':'v1','kind':'Secret','metadata':{'name':'aws-credentials','namespace':'view-show'},'type':'Opaque','stringData':{'AWS_ACCESS_KEY_ID':'local','AWS_SECRET_ACCESS_KEY':'local','AWS_EC2_METADATA_DISABLED':'true'}}
]},indent=2))
