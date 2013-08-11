---
layout: post
title:  "Sécuriser une application JSF avec Realm"
date:   2013-07-13 00:13:37
categories: articles
img: /images/securisation-JSF/cover.png
copy: echiner1
---

##Introduction
Pour sécuriser une application JSF sans utiliser d’autres frameworks tel que Spring ou Struts qui intègrent un module de sécurité (Spring Sécurity pour Spring), on peut utiliser Realm.<br/><br/>
Realm est un mécanisme servant à identifier les utilisateurs. Il permet de vérifier le login et le mot de passe d’un utilisateur afin de savoir si l’utilisateur connecté possède les droits suffisants pour consulter la ressource demandée.<br/><br/>
Pour chaque utilisateur, Realm connait la liste des rôles(Autorisations) associés à un utilisateur. La protection des ressources se fait par rôle, on indique le rôle dont doit disposer un utilisateur pour accéder à la ressource.
##Modes de fonctionnement de Realm

+ <b>Realm</b> possède plusieurs modes de fonctionnement pour le stockage des Utilisateurs et des roles. Il est possible d’utiliser:
+ <b>JDBCRealm</b> : Afin d’utiliser une base de données pour stocker les informations.
+ <b>LDAPRealm</b> : Permettant l’interrogation des services d’annuaire.
+ <b>FileRealm</b> : Permet de stocker les utilisateurs dans un fichier sur le serveur
+ PAM, OSGI, Certificate, LDAP, Oracle Solaris, et les sécurités personnalisées sont aussi supportées.

Coté client, les modes de connexion sont ceux définis par le protocole HTTP.

+ <b>Basic</b> : Cette méthode est la plus simple à mettre en place mais nécessite d’utiliser HTTPS afin de rester sûr.
+ <b>Digest</b>: Cette méthode transmet simplement le Hash du mot de passe.
+ <b>Certificat</b> : Permet d’authentifier un utilisateur avec un certificat.

##Implémentation de Realm avec JSF dans GlassFish
###Realm sur GlassFish

Afin d’utiliser realm avec GlassFish, il est nécessaire d’ajouter dans GlassFish les Utilisateurs (Utilisation de FileRealm).

Pour cela:
{% highlight xml %}
Interface d'administration de GlassFish > Configurations > Server-config
> security > Realms > File (Dans notre cas)
{% endhighlight %}
Si le Realm n’existe pas, cliquer sur `<new>` afin de créer celui souhaité (FileRealm, JDBCRealm, LDAPRealm)
Ensuite, il est nécessaire d’ajouter les utilisateurs. Cliquer sur `<Manage users>` puis sur `<New>`.
Remplissez les champs de l’utilisateur nom, mot de passe ainsi que les rôles de celui-ci
exemple:
{% highlight xml %}
ADMIN:USER:CONFIG ....
{% endhighlight %}
###Dans l’application web

Il faut ajouter au fichier web.xml la liste des adresses à sécuriser ainsi que les rôles nécessaires pour y accéder.
{% highlight xml %}
<!-- web.xml -->
<wep-app>
  ...
   <!-- liste des contraintes -->
   <security-constraint>
       <display-name>Constraint1</display-name>
       <!-- Url à sécurisée  -->
       <web-resource-collection>
           <web-resource-name>Administration</web-resource-name>
           <description/>
           <url-pattern>/admin/*</url-pattern>
       </web-resource-collection>
       <!-- Rôle requis -->
       <auth-constraint>
           <description/>
           <role-name>ADMIN</role-name>
       </auth-constraint>
       <!-- Utilisation de HTTPS -->
       <user-data-constraint>
           <description/>
           <transport-guarantee>CONFIDENTIAL</transport-guarantee>
       </user-data-constraint>
   </security-constraint>
   <!-- utilisation de FileRealms -->
   <login-config>
       <auth-method>BASIC</auth-method>
       <realm-name>file</realm-name>
   </login-config>
   <!--Définition du rôle -->
   <security-role>
       <description>Admin roles</description>
       <role-name>ADMIN</role-name>
   </security-role>
</web-app>
{% endhighlight %}
Enfin, il faut ajouter au fichier sun-web.xml le mapping des rôles. Afin de faire la liaison entre les rôles de l’application et ceux du serveur.

Sinon lors de la connexion d’un utilisateur, les ressources ne seront pas accessibles, un message du type « Access to the requested resource has been denied » sera affiché.
{% highlight xml %}
<glassfish-web-app error-url="">
	<context-root>/</context-root>
	<security-role-mapping>
	<role-name>ADMIN</role-name>
	<group-name>ADMIN</group-name>
    </security-role-mapping>
</glassfish-web-app>
{% endhighlight %}
Créer un répertoire /admin dans le dossier web de votre projet et essayez d’y accéder.
Une fenêtre vous demandra de vous identifier.